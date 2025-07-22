const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();

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

app.use(require('morgan')('dev'));
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(helmet({ contentSecurityPolicy: false }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        success: false,
        error: "Too many requests, please try again later.",
        result: { flights: [] }
    }
});

// Helper functions
function formatMomentTime(momentObj, use24 = false) {
    if (!momentObj || !momentObj.isValid()) return '';
    return momentObj.format(use24 ? 'HH:mm' : 'hh:mm A');
}

function calculateAndFormatDuration(depMoment, arrMoment) {
    if (!depMoment || !depMoment.isValid() || !arrMoment || !arrMoment.isValid())
        return 'Invalid time';
    const durationMinutes = arrMoment.diff(depMoment, 'minutes');
    if (durationMinutes < 0) return 'Invalid duration';
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    const paddedHours = String(hours).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');
    return `${paddedHours}h ${paddedMinutes}m`;
}

function getTravelClassName(classCode) {
    if (!classCode) return 'Unknown';
    const code = classCode.toUpperCase();
    const firstCodes = ['F', 'A'];
    const businessCodes = ['J', 'C', 'D', 'I', 'Z', 'P'];
    const premiumEconomyCodes = [];
    const economyCodes = ['Y', 'B', 'H', 'K', 'L', 'M', 'N', 'O', 'Q', 'S', 'U', 'V', 'X', 'G', 'W', 'E', 'T', 'R'];
    if (firstCodes.includes(code)) return 'First';
    if (businessCodes.includes(code)) return 'Business';
    if (premiumEconomyCodes.includes(code)) return 'Premium Economy';
    if (economyCodes.includes(code)) return 'Economy';
    return `Class ${code}`;
}

function getMealDescription(mealCode) {
    if (!mealCode) return null;

    const mealCodeMap = {
        B: 'Breakfast',
        L: 'Lunch',
        D: 'Dinner',
        S: 'Snack or Refreshments',
        M: 'Meal (Non-Specific)',
        F: 'Food for Purchase',
        H: 'Hot Meal',
        C: 'Complimentary Alcoholic Beverages',
        V: 'Vegetarian Meal',
        K: 'Kosher Meal',
        O: 'Cold Meal',
        P: 'Alcoholic Beverages for Purchase',
        R: 'Refreshment',
        W: 'Continental Breakfast',
        Y: 'Duty-Free Sales Available',
        N: 'No Meal Service',
        G: 'Food and Beverages for Purchase',
    };

    const descriptions = mealCode
        .toUpperCase()
        .split('')
        .map(code => mealCodeMap[code])
        .filter(Boolean);

    if (descriptions.length === 0) {
        return `${mealCode}`;
    }

    return descriptions.join(' & ');
}

// --- YOUR UPDATED PARSER FUNCTION ---
function parseGalileoEnhanced(pnrText, options) {
    options = options || {};
    const rawText = (pnrText || '').toUpperCase();
    const flights = [];
    const passengers = [];
    const lines = rawText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    let previousArrivalMoment = null;

    const flightSegmentRegexCompact = /^\s*(\d+)\s+(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}|\+\d))?/;

    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const originalLine of lines) {
        if (!originalLine) continue;

        let line = originalLine;
        let flightMatch = line.match(flightSegmentRegexCompact);

        let segmentNumStr,
            operatedCarrier,
            airlineCode,
            flightNumRaw,
            travelClass,
            depDateStr,
            depAirport,
            arrAirport,
            depTimeStr,
            arrTimeStr,
            arrDateStrOrNextDayIndicator,
            depTerminal,
            arrTerminal;

        if (!flightMatch) {
            // Try flexible
            flightMatch = line.match(flightSegmentRegexFlexible);
        }

        if (!flightMatch) {
            // Remove all spaces and try compact again
            line = line.replace(/\s+/g, '');
            flightMatch = line.match(flightSegmentRegexCompact);
        }

        if (flightMatch) {
            [
                ,
                segmentNumStr,
                operatedCarrier,
                airlineCode,
                flightNumRaw,
                travelClass,
                depDateStr,
                depAirport,
                arrAirport,
                depTimeStr,
                arrTimeStr,
                arrDateStrOrNextDayIndicator,
            ] = flightMatch;
        }

        const operatedByMatch = originalLine.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(originalLine);

        if (isPassengerLine) {
            const cleanedLine = originalLine.replace(/^\s*\d+\.\s*/, '');
            const nameBlocks = cleanedLine.split(/\s+\d+\.\s*/);
            for (const nameBlock of nameBlocks) {
                if (!nameBlock.trim()) continue;
                const nameParts = nameBlock.trim().split('/');
                if (nameParts.length < 2) continue;
                const lastName = nameParts[0].trim();
                const givenNamesAndTitleRaw = nameParts[1].trim();
                const titles = ['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'CHD', 'INF'];
                const words = givenNamesAndTitleRaw.split(/\s+/);
                const lastWord = words[words.length - 1].toUpperCase();
                let title = '';
                if (titles.includes(lastWord)) title = words.pop();
                const givenNames = words.join(' ');
                if (lastName && givenNames) {
                    let formattedName = `${lastName.toUpperCase()}/${givenNames.toUpperCase()}`;
                    if (title) formattedName += ` ${title}`;
                    if (!passengers.includes(formattedName)) passengers.push(formattedName);
                }
            }
        } else if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;
            let precedingTransitTimeForThisSegment = null;
            let transitDurationInMinutes = null;
            let formattedNextDepartureTime = null;

            const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };
            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

            const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, 'DDMMM HHmm', true, depAirportInfo.timezone);

            let arrivalMoment;

            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().add(daysToAdd, 'day').hour(arrTimeStr.slice(0, 2)).minute(arrTimeStr.slice(2, 4));
                } else {
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator} ${arrTimeStr}`, 'DDMMM HHmm', true, arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, 'DDMMM HHmm', true, arrAirportInfo.timezone);
                if (
                    departureMoment.isValid() &&
                    arrivalMoment.isValid() &&
                    arrivalMoment.isSameOrBefore(departureMoment)
                ) {
                    arrivalMoment.add(1, 'day');
                }
            }

            if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment && departureMoment.isValid()) {
                const transitDuration = moment.duration(departureMoment.diff(previousArrivalMoment));
                const totalMinutes = transitDuration.asMinutes();
                if (totalMinutes > 30 && totalMinutes < 1440) {
                    const hours = Math.floor(transitDuration.asHours());
                    const minutes = transitDuration.minutes();
                    precedingTransitTimeForThisSegment = `${hours < 10 ? '0' : ''}${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
                    transitDurationInMinutes = Math.round(totalMinutes);
                    formattedNextDepartureTime = formatMomentTime(departureMoment, options.segmentTimeFormat === '24h');
                }
            }

            let arrivalDateString = null;
            if (departureMoment.isValid() && arrivalMoment && arrivalMoment.isValid() && !arrivalMoment.isSame(departureMoment, 'day')) {
                arrivalDateString = arrivalMoment.format('DD MMM');
            }

            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                operatedCarrier: operatedCarrier || null,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber: flightNumRaw,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : '',
                departure: {
                    airport: depAirport,
                    city: depAirportInfo.city,
                    name: depAirportInfo.name,
                    time: formatMomentTime(departureMoment, options.segmentTimeFormat === '24h'),
                },
                arrival: {
                    airport: arrAirport,
                    city: arrAirportInfo.city,
                    name: arrAirportInfo.name,
                    time: arrivalMoment ? formatMomentTime(arrivalMoment, options.segmentTimeFormat === '24h') : '',
                    dateString: arrivalDateString,
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                notes: [],
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes, // ✅ must match the declared name!
                formattedNextDepartureTime: formattedNextDepartureTime,
            };

            previousArrivalMoment = arrivalMoment ? arrivalMoment.clone() : previousArrivalMoment;
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && originalLine.trim().length > 0) {
            currentFlight.notes.push(originalLine.trim());
        }
    }

    if (currentFlight) flights.push(currentFlight);

    return { flights, passengers };
}
app.use('/api', limiter);

// Optional: Load your old parser (uncomment if needed)
// const oldParser = require('./oldParser');

app.post('/api/convert', (req, res) => {
    try {
        const { pnrText, options } = req.body;
        const text = (pnrText || '').toUpperCase();

        // Uncomment and use old parser if you want:
        // const result = options && options.useOldParser ? oldParser.parse(text, options) : parseGalileoEnhanced(text, options);
        const result = parseGalileoEnhanced(text, options);

        return res.status(200).json({ success: true, result, pnrProcessingAttempted: !!text });
    } catch (e) {
        return res.status(400).json({ success: false, error: e.message, result: { flights: [] } });
    }
});

app.listen(4000, () => {
    console.log('PNR converter server running on port 4000');
});
