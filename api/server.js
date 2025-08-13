const express = require('express');
const moment = require('moment-timezone');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1);

const DATA_DIR = path.join(process.cwd(), 'data');
const AIRLINES_FILE = path.join(DATA_DIR, 'airlines.json');
const AIRCRAFT_TYPES_FILE = path.join(DATA_DIR, 'aircraftTypes.json');
const AIRPORT_DATABASE_FILE = path.join(DATA_DIR, 'airportDatabase.json');

app.use(express.json());

let airlineDatabase = {};
let aircraftTypes = {};
let airportDatabase = {};

function loadDbFromFile(filePath, defaultDb) {
    try {
        if (fs.existsSync(filePath)) {
            const fileData = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(fileData);
        }
    } catch (error) {
        console.error(`Error loading ${path.basename(filePath)}:`, error.message);
    }
    return defaultDb;
}

function loadAllDatabases() {
    airlineDatabase = loadDbFromFile(AIRLINES_FILE, {});
    aircraftTypes = loadDbFromFile(AIRCRAFT_TYPES_FILE, {});
    airportDatabase = loadDbFromFile(AIRPORT_DATABASE_FILE, {});
}

loadAllDatabases();

app.use(morgan('dev'));

const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : null;
app.use(cors(allowedOrigins ? {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        return callback(new Error('Not allowed by CORS'));
    },
    credentials: true
} : {}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(helmet({
    contentSecurityPolicy: {
        useDefaults: true,
        directives: {
            "img-src": ["'self'", "data:", "blob:"],
            "script-src": ["'self'", "'unsafe-inline'"],
            "style-src": ["'self'", "'unsafe-inline'"],
            "connect-src": ["'self'", "*"]
        }
    }
}));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { success: false, error: "Too many requests, please try again later.", result: { flights: [] } }
});

app.post('/api/convert', limiter, (req, res) => {
    try {
        const { pnrText, options } = req.body;
        const pnrTextForProcessing = (pnrText || '').toUpperCase();
        const serverOptions = options || {};
        const result = pnrTextForProcessing
            ? parseGalileoEnhanced(pnrTextForProcessing, serverOptions)
            : { flights: [], passengers: [] };
        return res.status(200).json({ success: true, result, pnrProcessingAttempted: !!pnrTextForProcessing });
    } catch (err) {
        console.error("Error during PNR conversion:", err.stack);
        return res.status(500).json({ success: false, error: err.message, result: { flights: [] } });
    }
});

app.post('/api/upload-logo', limiter, async (req, res) => {
    console.error("Logo upload is not supported on Vercel's read-only filesystem.");
    return res.status(400).json({ success: false, error: "This feature is disabled on the live deployment." });
});

// --- Utility functions ---
function normalizeTerminal(term) { if (!term) return null; const t = String(term).trim(); if (!t) return null; return 'T' + t.replace(/^T/i, ''); }
function formatMomentTime(momentObj, use24 = false) { if (!momentObj || !momentObj.isValid()) return ''; return momentObj.format(use24 ? 'HH:mm' : 'hh:mm A'); }
function calculateAndFormatDuration(depMoment, arrMoment) { if (!depMoment || !depMoment.isValid() || !arrMoment || !arrMoment.isValid()) return 'Invalid time'; const durationMinutes = arrMoment.diff(depMoment, 'minutes'); if (durationMinutes < 0) return 'Invalid duration'; const hours = Math.floor(durationMinutes / 60); const minutes = durationMinutes % 60; return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`; }
function getTravelClassName(classCode) { if (!classCode) return 'Unknown'; const code = classCode.toUpperCase(); if (['F', 'A'].includes(code)) return 'First'; if (['J', 'C', 'D', 'I', 'Z', 'P'].includes(code)) return 'Business'; if (['Y', 'B', 'H', 'K', 'L', 'M', 'N', 'O', 'Q', 'S', 'U', 'V', 'X', 'G', 'W', 'E', 'T', 'R'].includes(code)) return 'Economy'; return `Class ${code}`; }
function getMealDescription(mealCode) { if (!mealCode) return null; const map = { B: 'Breakfast', L: 'Lunch', D: 'Dinner', S: 'Snack', M: 'Meal', F: 'Food Purchase', H: 'Hot Meal', C: 'Complimentary Alcohol', V: 'Vegetarian', K: 'Kosher', O: 'Cold Meal', P: 'Alcoholic Purchase', R: 'Refreshment', W: 'Continental Breakfast', Y: 'Duty-Free', N: 'No Meal', G: 'Food Purchase' }; const descs = mealCode.toUpperCase().split('').map(c => map[c]).filter(Boolean); return descs.length ? descs.join(' & ') : mealCode; }

// --- PNR Parsing with all fixes ---
function parseGalileoEnhanced(pnrText, options) {
    const flights = [], passengers = [];
    const lines = pnrText.split('\n').map(l => l.trim());
    let currentFlight = null, flightIndex = 0, previousArrivalMoment = null;
    let currentYear = null, previousDepartureMonthIndex = -1;
    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';
    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const line of lines) {
        if (!line) continue;
        const flightMatch = line.match(flightSegmentRegexFlexible);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);
        const operatedByMatch = line.match(operatedByRegex);

        if (isPassengerLine) {
            const cleanedLine = line.replace(/^\s*\d+\.\s*/, '');
            const nameBlocks = cleanedLine.split(/\s+\d+\.\s*/);
            for (const nb of nameBlocks) {
                if (!nb.trim()) continue;
                const [lastName, rest] = nb.trim().split('/');
                if (!lastName || !rest) continue;
                let words = rest.trim().split(/\s+/), title = ''; const titles = ['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'CHD', 'INF'];
                if (titles.includes(words[words.length - 1].toUpperCase())) title = words.pop();
                const givenNames = words.join(' ');
                let formattedName = `${lastName.toUpperCase()}/${givenNames.toUpperCase()}`; if (title) formattedName += ` ${title}`;
                if (!passengers.includes(formattedName)) passengers.push(formattedName);
            }
        }
        else if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;
            let segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, depTerminal, arrAirport, arrTerminal, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator;
            [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, depTerminal, arrAirport, arrTerminal, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;

            const depAirportInfo = airportDatabase[depAirport] || { city: 'Unknown', name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: 'Unknown', name: `Airport (${arrAirport})`, timezone: 'UTC' };
            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

            const depDateMoment = moment.utc(depDateStr, "DDMMM");
            const currentDepartureMonthIndex = depDateMoment.month();
            if (currentYear === null) {
                currentYear = new Date().getFullYear();
                if (depDateMoment.year(currentYear).isBefore(moment().subtract(3, 'months'))) currentYear++;
            } else if (currentDepartureMonthIndex < previousDepartureMonthIndex) currentYear++;
            previousDepartureMonthIndex = currentDepartureMonthIndex;

            const fullDepDateStr = `${depDateStr}${currentYear}`;
            const departureMoment = moment.tz(fullDepDateStr + " " + depTimeStr, "DDMMMYYYY HHmm", true, depAirportInfo.timezone);

            let arrivalMoment;
            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().tz(arrAirportInfo.timezone).add(daysToAdd, 'day').set({ hour: parseInt(arrTimeStr.substring(0, 2)), minute: parseInt(arrTimeStr.substring(2, 4)) });
                } else {
                    const arrDateMoment = moment.utc(arrDateStrOrNextDayIndicator, "DDMMM");
                    let arrivalYear = currentYear;
                    if (arrDateMoment.month() < departureMoment.month()) arrivalYear++;
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator}${arrivalYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = moment.tz(`${fullDepDateStr} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                if (departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) arrivalMoment.add(1, 'day');
            }

            let precedingTransitTimeForThisSegment = null, transitDurationInMinutes = null, formattedNextDepartureTime = null;
            if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment && departureMoment.isValid()) {
                const td = moment.duration(departureMoment.diff(previousArrivalMoment));
                const mins = td.asMinutes();
                if (mins > 30 && mins < 1440) {
                    precedingTransitTimeForThisSegment = `${String(Math.floor(td.asHours())).padStart(2, '0')}h ${String(td.minutes()).padStart(2, '0')}m`;
                    transitDurationInMinutes = Math.round(mins);
                    formattedNextDepartureTime = formatMomentTime(departureMoment, use24hTransit);
                }
            }

            let aircraftCodeKey = null;
            const detailsParts = line.substring(flightMatch[0].length).trim().split(/\s+/);
            for (const part of detailsParts) {
                let code = part.toUpperCase();
                if (code.includes('/')) code = code.split('/').pop();
                if (code in aircraftTypes) { aircraftCodeKey = code; break; }
            }

            let mealCode = null;
            for (const p of detailsParts) { const tok = p.replace(/[^A-Za-z]/g, ''); if (/^[BLDSMFHCVKOPRWYNG]+$/i.test(tok)) { mealCode = tok; break; } }

            let arrivalDateString = null;
            if (departureMoment.isValid() && arrivalMoment.isValid() && !arrivalMoment.isSame(departureMoment, 'day')) arrivalDateString = arrivalMoment.format('DD MMM');

            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber: flightNumRaw,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : '',
                departure: { airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name, time: formatMomentTime(departureMoment, use24hSegment), terminal: normalizeTerminal(depTerminal) },
                arrival: { airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name, time: formatMomentTime(arrivalMoment, use24hSegment), dateString: arrivalDateString, terminal: normalizeTerminal(arrTerminal) },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: getMealDescription(mealCode),
                notes: [],
                operatedBy: null,
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes,
                formattedNextDepartureTime: formattedNextDepartureTime
            };
            previousArrivalMoment = arrivalMoment.clone();
        }
        else if (currentFlight && operatedByMatch) currentFlight.operatedBy = operatedByMatch[1].trim();
        else if (currentFlight && line.trim().length > 0) currentFlight.notes.push(line.trim());
    }
    if (currentFlight) flights.push(currentFlight);

    // --- Outbound/Inbound leg detection ---
    if (flights.length > 0) {
        flights[0].direction = 'Outbound';
        const STOPOVER_THRESHOLD_MINUTES = 1440;
        const format12h = "DD MMM YYYY hh:mm A";
        const format24h = "DD MMM YYYY HH:mm";
        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currFlight = flights[i];
            const prevArrInfo = airportDatabase[prevFlight.arrival.airport] || { timezone: 'UTC' };
            const currDepInfo = airportDatabase[currFlight.departure.airport] || { timezone: 'UTC' };
            if (!moment.tz.zone(prevArrInfo.timezone)) prevArrInfo.timezone = 'UTC';
            if (!moment.tz.zone(currDepInfo.timezone)) currDepInfo.timezone = 'UTC';
            const prevTimeFormat = prevFlight.arrival.time.includes('M') ? format12h : format24h;
            const currTimeFormat = currFlight.departure.time.includes('M') ? format12h : format24h;
            const prevYear = prevFlight.date.split(', ')[1].split(' ')[2];
            const prevArrDateStr = prevFlight.arrival.dateString ? `${prevFlight.arrival.dateString} ${prevYear}` : prevFlight.date.split(', ')[1];
            const arrivalOfPrev = moment.tz(`${prevArrDateStr} ${prevFlight.arrival.time}`, prevTimeFormat, true, prevArrInfo.timezone);
            const departureOfCurr = moment.tz(`${currFlight.date.split(', ')[1]} ${currFlight.departure.time}`, currTimeFormat, true, currDepInfo.timezone);
            if (arrivalOfPrev.isValid() && departureOfCurr.isValid()) {
                const stopoverMinutes = departureOfCurr.diff(arrivalOfPrev, 'minutes');
                if (stopoverMinutes > STOPOVER_THRESHOLD_MINUTES) {
                    const orig = flights[0].departure.airport;
                    const dest = flights[flights.length - 1].arrival.airport;
                    const isRoundTrip = orig === dest;
                    currFlight.direction = isRoundTrip ? 'Inbound' : 'Outbound';
                }
            }
        }
    }

    return { flights, passengers };
}

module.exports = app;