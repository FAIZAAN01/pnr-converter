const express = require('express');
// const bodyParser = require('body-parser'); // replaced with express.json/urlencoded
const moment = require('moment-timezone');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');

const app = express();
app.set('trust proxy', 1); // trust first proxy

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
// To restrict, set CORS_ORIGINS="https://app.example.com,https://admin.example.com"
const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map(o => o.trim()) : null;
app.use(cors(allowedOrigins ? {
    origin: function (origin, callback) {
        if (!origin) return callback(null, true); // same-origin or non-browser
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

        const responsePayload = {
            success: true,
            result,
            pnrProcessingAttempted: !!pnrTextForProcessing
        };

        return res.status(200).json(responsePayload);

    } catch (err) {
        console.error("Error during PNR conversion:", err.stack);
        return res.status(500).json({ success: false, error: err.message, result: { flights: [] } });
    }
});


app.post('/api/upload-logo', limiter, async (req, res) => {
    console.error("Logo upload is not supported on Vercel's read-only filesystem.");
    return res.status(400).json({ success: false, error: "This feature is disabled on the live deployment." });
});

function normalizeTerminal(term) {
    if (!term) return null;
    const t = String(term).trim();
    if (!t) return null;
    const bare = t.replace(/^T/i, '');
    return '' + bare;
}

function formatMomentTime(momentObj, use24 = false) {
    if (!momentObj || !momentObj.isValid()) return '';
    return momentObj.format(use24 ? 'HH:mm' : 'hh:mm A');
}
function calculateAndFormatDuration(depMoment, arrMoment) {
    if (!depMoment || !depMoment.isValid() || !arrMoment || !arrMoment.isValid()) return 'Invalid time';
    const durationMinutes = arrMoment.diff(depMoment, 'minutes');
    if (durationMinutes < 0) return 'Invalid duration';
    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;
    const paddedHours = String(hours).padStart(2, '0');
    const paddedMinutes = String(minutes).padStart(2, '0');
    // Return the formatted string instead of assigning it to another variable
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
        'B': 'Breakfast',
        'L': 'Lunch',
        'D': 'Dinner',
        'S': 'Snack or Refreshments',
        'M': 'Meal (Non-Specific)',
        'F': 'Food for Purchase',
        'H': 'Hot Meal',
        'C': 'Complimentary Alcoholic Beverages',
        'V': 'Vegetarian Meal',
        'K': 'Kosher Meal',
        'O': 'Cold Meal',
        'P': 'Alcoholic Beverages for Purchase',
        'R': 'Refreshment',
        'W': 'Continental Breakfast',
        'Y': 'Duty-Free Sales Available',
        'N': 'No Meal Service',
        'G': 'Food and Beverages for Purchase',
    };

    const descriptions = mealCode.toUpperCase().split('')
        .map(code => mealCodeMap[code])
        .filter(Boolean); // Filter out any undefined results for unknown characters

    if (descriptions.length === 0) {
        return `${mealCode}`; // Fallback for unknown codes
    }

    return descriptions.join(' & ');
}

// PASTE THIS ENTIRE FUNCTION OVER YOUR OLD ONE

function parseGalileoEnhanced(pnrText, options) {
    const flights = [];
    const passengers = [];
    const lines = pnrText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    let previousArrivalMoment = null;

    let currentYear = null;
    let previousDepartureMonthIndex = -1;

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    const flightSegmentRegexCompact = /^\s*(\d+)\s+([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (let rawLine of lines) {
        if (!rawLine) continue;

        // Remove any leading "*" for codeshare/indicator flights
        let line = rawLine.replace(/^\s*\*/, '');

        let flightMatch = line.match(flightSegmentRegexCompact);
        let segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator, depTerminal, arrTerminal;

        if (flightMatch) {
            [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            depTerminal = null;
            arrTerminal = null;
        } else {
            flightMatch = line.match(flightSegmentRegexFlexible);
            if (flightMatch) {
                [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, depTerminal, arrAirport, arrTerminal, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            }
        }

        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) {
            const cleanedLine = line.replace(/^\s*\d+\.\s*/, '');
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
        }
        else if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;
            let precedingTransitTimeForThisSegment = null;
            let transitDurationInMinutes = null;
            let formattedNextDepartureTime = null;

            const flightDetailsPart = line.substring(flightMatch[0].length).trim();
            const detailsParts = flightDetailsPart.split(/\s+/);

            // --- START OF THE FIX ---
            let aircraftCodeKey = null;
            // We loop through the leftover parts of the line to find the aircraft code.
            for (let part of detailsParts) {
                let potentialCode = part.toUpperCase();
                // If the part contains a slash (like "E0/7M8"), we isolate the part after the slash.
                if (potentialCode.includes('/')) {
                    potentialCode = potentialCode.split('/').pop();
                }
                // Now we check if this corrected code ("7M8") is a valid aircraft type.
                if (potentialCode in aircraftTypes) {
                    aircraftCodeKey = potentialCode; // We found it!
                    break; // Stop searching.
                }
            }
            // --- END OF THE FIX ---

            const validMealCharsRegex = /^[BLDSMFHCVKOPRWYNG]+$/i;
            let mealCode = null;
            for (const p of detailsParts) {
                const tok = p.replace(/[^A-Za-z]/g, '');
                if (validMealCharsRegex.test(tok)) { mealCode = tok; break; }
            }

            const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };

            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';

            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

            const depDateMoment = moment.utc(depDateStr, "DDMMM");

            const currentDepartureMonthIndex = depDateMoment.month(); // December is 11, January is 0

            if (currentYear === null) {
                currentYear = new Date().getFullYear();
                // Heuristic: If the flight date is more than 3 months in the past,
                // assume the PNR is for next year.
                const prospectiveDate = depDateMoment.year(currentYear);
                if (prospectiveDate.isBefore(moment().subtract(3, 'months'))) {
                    currentYear++;
                }
            }

            // Step C: If the current month is earlier than the previous one, we've rolled over the year
            else if (currentDepartureMonthIndex < previousDepartureMonthIndex) {
                currentYear++;
            }

            previousDepartureMonthIndex = currentDepartureMonthIndex;

            // const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone);

            const fullDepDateStr = `${depDateStr}${currentYear}`;
            const departureMoment = moment.tz(fullDepDateStr + " " + depTimeStr, "DDMMMYYYY HHmm", true, depAirportInfo.timezone);

            let arrivalMoment;

            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().tz(arrAirportInfo.timezone)
                        .add(daysToAdd, 'day')
                        .set({ hour: parseInt(arrTimeStr.substring(0, 2)), minute: parseInt(arrTimeStr.substring(2, 4)) });
                } else {
                    // Handles explicit arrival date (e.g., 02JAN)
                    const arrDateMoment = moment.utc(arrDateStrOrNextDayIndicator, "DDMMM");
                    let arrivalYear = currentYear;
                    if (arrDateMoment.month() < departureMoment.month()) {
                        arrivalYear++;
                    }
                    const fullArrDateStr = `${arrDateStrOrNextDayIndicator}${arrivalYear}`;
                    arrivalMoment = moment.tz(`${fullArrDateStr} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                // Only add 1 day if arrival time is before departure and no explicit arrival date
                arrivalMoment = moment.tz(`${fullDepDateStr} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                if (departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) {
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
                    formattedNextDepartureTime = formatMomentTime(departureMoment, use24hTransit);
                }
            }

            let arrivalDateString = null;
            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    arrivalDateString = `+${parseInt(arrDateStrOrNextDayIndicator.substring(1), 10)}`;
                } else {
                    // Explicit date like "09JAN"
                    if (arrDateStrOrNextDayIndicator !== depDateStr) {
                        arrivalDateString = arrDateStrOrNextDayIndicator; // keep as in PNR
                    }
                }
            } else {
                // No explicit arrival date given, check time to see if next day
                if (arrTimeStr < depTimeStr) {
                    arrivalDateString = "+1";
                }
            }

            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber: flightNumRaw,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : '',
                departure: {
                    airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name,
                    time: formatMomentTime(departureMoment, use24hSegment),
                    terminal: normalizeTerminal(depTerminal)
                },
                arrival: {
                    airport: arrAirport,
                    city: arrAirportInfo.city,
                    name: arrAirportInfo.name,
                    time: arrTimeStr.substring(0, 2) + ':' + arrTimeStr.substring(2, 4), // raw, no moment
                    dateString: arrivalDateString,
                    terminal: normalizeTerminal(arrTerminal)
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                // This line now correctly uses the found aircraftCodeKey
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: getMealDescription(mealCode),//-------edit
                notes: [],
                operatedBy: null,
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes,
                formattedNextDepartureTime: formattedNextDepartureTime
            };
            previousArrivalMoment = arrivalMoment.clone();
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    // --- START: REFINED LOGIC FOR / LEG DETECTION ---

    if (flights.length > 0) {
        for (const flight of flights) {
            flight.direction = null;
        }
        flights[0].direction = '';

        const STOPOVER_THRESHOLD_MINUTES = 1440; // 24 hours

        // Define both possible time formats
        const format12h = "DD MMM YYYY hh:mm A";
        const format24h = "DD MMM YYYY HH:mm";

        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currentFlight = flights[i];

            const prevArrAirportInfo = airportDatabase[prevFlight.arrival.airport] || { timezone: 'UTC' };
            if (!moment.tz.zone(prevArrAirportInfo.timezone)) prevArrAirportInfo.timezone = 'UTC';

            const currDepAirportInfo = airportDatabase[currentFlight.departure.airport] || { timezone: 'UTC' };
            if (!moment.tz.zone(currDepAirportInfo.timezone)) currDepAirportInfo.timezone = 'UTC';

            // --- Start of the fix ---

            // Determine the correct format string for the previous flight's arrival time
            const prevTimeFormat = prevFlight.arrival.time.includes('M') ? format12h : format24h;
            // Determine the correct format string for the current flight's departure time
            const currTimeFormat = currentFlight.departure.time.includes('M') ? format12h : format24h;

            // --- End of the fix ---

            const prevYear = prevFlight.date.split(', ')[1].split(' ')[2];
            const prevArrivalDateStr = prevFlight.arrival.dateString ? `${prevFlight.arrival.dateString} ${prevYear}` : prevFlight.date.split(', ')[1];

            // Use the detected format for parsing
            const arrivalOfPreviousFlight = moment.tz(`${prevArrivalDateStr} ${prevFlight.arrival.time}`, prevTimeFormat, true, prevArrAirportInfo.timezone);
            const departureOfCurrentFlight = moment.tz(`${currentFlight.date.split(', ')[1]} ${currentFlight.departure.time}`, currTimeFormat, true, currDepAirportInfo.timezone);

            if (arrivalOfPreviousFlight.isValid() && departureOfCurrentFlight.isValid()) {
                const stopoverMinutes = departureOfCurrentFlight.diff(arrivalOfPreviousFlight, 'minutes');

                if (stopoverMinutes > STOPOVER_THRESHOLD_MINUTES) {
                    const originalOrigin = flights[0].departure.airport;
                    const finalDestination = flights[flights.length - 1].arrival.airport;
                    const isRoundTrip = originalOrigin === finalDestination;

                    currentFlight.direction = isRoundTrip ? '' : '';
                }
            } else {
                // This else block is for debugging and can be removed later
                console.error("Moment.js parsing failed! Check formats.");
                console.error(`- Previous Arrival: '${prevFlight.arrival.time}' with format '${prevTimeFormat}'`);
                console.error(`- Current Departure: '${currentFlight.departure.time}' with format '${currTimeFormat}'`);
            }
        }
    }
    // --- END: CORRECTED LOGIC ---

    return { flights, passengers };
}

module.exports = app;
