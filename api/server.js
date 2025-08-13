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
    const flights = [];
    const passengers = [];
    const lines = pnrText.split('\n').map(line => line.trim()).filter(Boolean);

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    let currentYear = new Date().getFullYear();
    let previousDepartureMonthIndex = -1;
    let previousArrivalMoment = null;
    let currentFlight = null;

    const flightLineRegex = /^\d+\s+([A-Z0-9]{2,3})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+(\d{2}[A-Z]{3})\s+(\d+)\*?([A-Z]{6})\s+([A-Z]{2}\d+)\s+(\d{4})\s+(\d{4})(?:\s+(\d{2}[A-Z]{3}))?\s+[A-Z]\s+\d\s+([A-Z0-9]+)?/i;
    const operatedByRegex = /^OPERATED BY\s+(.+)/i;
    const passengerLineRegex = /^\d+\.\s*[A-Z/]+/;

    for (let line of lines) {
        // Passenger line
        if (passengerLineRegex.test(line)) {
            const cleanedLine = line.replace(/^\d+\.\s*/, '');
            const nameParts = cleanedLine.split('/');
            if (nameParts.length >= 2) {
                const lastName = nameParts[0].trim().toUpperCase();
                const givenNames = nameParts[1].trim().toUpperCase();
                if (!passengers.includes(`${lastName}/${givenNames}`)) {
                    passengers.push(`${lastName}/${givenNames}`);
                }
            }
            continue;
        }

        // OPERATED BY line
        const operatedMatch = line.match(operatedByRegex);
        if (operatedMatch && currentFlight) {
            currentFlight.operatedBy = operatedMatch[1].trim();
            continue;
        }

        // Flight segment line
        const flightMatch = line.match(flightLineRegex);
        if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);

            const [
                ,
                airlineCode,
                flightNumber,
                travelClass,
                depDateStr,
                depAirport,
                arrAirport,
                depTimeStr,
                arrTimeStr,
                arrDateStrOrNextDayIndicator,
                aircraftCode
            ] = flightMatch;

            const depAirportInfo = airportDatabase[depAirport] || { city: 'Unknown', name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: 'Unknown', name: `Airport (${arrAirport})`, timezone: 'UTC' };

            // Default to UTC if timezone not found
            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

            // Handle year rollover
            let depMoment = moment.tz(`${depDateStr}${currentYear} ${depTimeStr}`, "DDMMMYYYY HHmm", depAirportInfo.timezone);
            const currentDepMonth = depMoment.month();
            if (previousDepartureMonthIndex > -1 && currentDepMonth < previousDepartureMonthIndex) {
                currentYear++;
                depMoment = moment.tz(`${depDateStr}${currentYear} ${depTimeStr}`, "DDMMMYYYY HHmm", depAirportInfo.timezone);
            }
            previousDepartureMonthIndex = currentDepMonth;

            // Arrival moment calculation
            let arrMoment;
            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const addDays = parseInt(arrDateStrOrNextDayIndicator.slice(1));
                    arrMoment = depMoment.clone().tz(arrAirportInfo.timezone).add(addDays, 'day')
                        .set({ hour: parseInt(arrTimeStr.slice(0, 2)), minute: parseInt(arrTimeStr.slice(2, 4)) });
                } else {
                    let arrYear = currentYear;
                    const arrDateMoment = moment(arrDateStrOrNextDayIndicator, "DDMMM");
                    if (arrDateMoment.month() < depMoment.month()) arrYear++;
                    arrMoment = moment.tz(`${arrDateStrOrNextDayIndicator}${arrYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", arrAirportInfo.timezone);
                }
            } else {
                arrMoment = depMoment.clone().tz(arrAirportInfo.timezone)
                    .set({ hour: parseInt(arrTimeStr.slice(0, 2)), minute: parseInt(arrTimeStr.slice(2, 4)) });
                if (arrMoment.isBefore(depMoment)) arrMoment.add(1, 'day');
            }

            // Transit calculation
            let transitTime = null;
            let transitMinutes = null;
            if (previousArrivalMoment && previousArrivalMoment.isValid()) {
                const diff = moment.duration(depMoment.diff(previousArrivalMoment));
                const totalMin = diff.asMinutes();
                if (totalMin > 30 && totalMin < 1440) {
                    transitTime = `${Math.floor(diff.asHours()).toString().padStart(2, '0')}h ${diff.minutes().toString().padStart(2, '0')}m`;
                    transitMinutes = Math.round(totalMin);
                }
            }

            const arrivalDateString = !arrMoment.isSame(depMoment, 'day') ? arrMoment.format('DD MMM') : null;

            currentFlight = {
                segment: flights.length + 1,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber,
                travelClass: { code: travelClass, name: getTravelClassName(travelClass) },
                date: depMoment.format('dddd, DD MMM YYYY'),
                departure: {
                    airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name,
                    time: formatMomentTime(depMoment, use24hSegment),
                    terminal: null
                },
                arrival: {
                    airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name,
                    time: formatMomentTime(arrMoment, use24hSegment),
                    dateString: arrivalDateString,
                    terminal: null
                },
                duration: calculateAndFormatDuration(depMoment, arrMoment),
                aircraft: aircraftTypes[aircraftCode] || aircraftCode || '',
                meal: null,
                notes: [],
                operatedBy: null,
                transitTime,
                transitDurationMinutes: transitMinutes,
                formattedNextDepartureTime: transitTime ? formatMomentTime(depMoment, use24hTransit) : null
            };

            previousArrivalMoment = arrMoment.clone();
            continue;
        }

        // Anything else is a note for the current flight
        if (currentFlight) currentFlight.notes.push(line);
    }

    if (currentFlight) flights.push(currentFlight);

    // Assign outbound/inbound
    if (flights.length > 0) flights[0].direction = 'Outbound';
    if (flights.length > 1) flights[flights.length - 1].direction = 'Inbound';

    return { flights, passengers };
}


module.exports = app;