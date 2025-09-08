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

// PASTE THIS ENTIRE FUNCTION OVER YOUR OLD ONE (in the first server.js file)

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

            let aircraftCodeKey = null;
            for (let part of detailsParts) {
                let potentialCode = part.toUpperCase();
                if (potentialCode.includes('/')) {
                    potentialCode = potentialCode.split('/').pop();
                }
                if (potentialCode in aircraftTypes) {
                    aircraftCodeKey = potentialCode;
                    break;
                }
            }

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

            const currentDepartureMonthIndex = depDateMoment.month();

            if (currentYear === null) {
                currentYear = new Date().getFullYear();
                const prospectiveDate = depDateMoment.year(currentYear);
                if (prospectiveDate.isBefore(moment().subtract(3, 'months'))) {
                    currentYear++;
                }
            } else if (currentDepartureMonthIndex < previousDepartureMonthIndex) {
                currentYear++;
            }

            previousDepartureMonthIndex = currentDepartureMonthIndex;

            const fullDepDateStr = `${depDateStr}${currentYear}`;
            const departureMoment = moment.tz(fullDepDateStr + " " + depTimeStr, "DDMMMYYYY HHmm", true, depAirportInfo.timezone);

            let arrivalMoment;

            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().add(daysToAdd, 'days')
                        .set({
                            hour: parseInt(arrTimeStr.substring(0, 2)),
                            minute: parseInt(arrTimeStr.substring(2, 4))
                        });
                } else {
                    const arrDateMoment = moment.utc(arrDateStrOrNextDayIndicator, "DDMMM");
                    let arrivalYear = departureMoment.year();
                    if (arrDateMoment.month() < departureMoment.month()) arrivalYear++;
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator}${arrivalYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = moment.tz(`${depDateStr}${currentYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                if (arrivalMoment.isBefore(departureMoment)) arrivalMoment.add(1, 'day');
            }

            if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment && departureMoment.isValid()) {
                const transitDuration = moment.duration(departureMoment.diff(previousArrivalMoment));
                const transitMinutes = transitDuration.asMinutes();

                if (transitMinutes > 30 && transitMinutes < 1440) {
                    const hours = Math.floor(transitMinutes / 60);
                    const minutes = Math.floor(transitMinutes % 60);
                    precedingTransitTimeForThisSegment = `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m`;
                    transitDurationInMinutes = transitMinutes;
                    formattedNextDepartureTime = formatMomentTime(departureMoment, use24hTransit);
                }
            }
            previousArrivalMoment = arrivalMoment.clone();

            let arrivalDateString = null;
            if (arrivalMoment.isValid() && departureMoment.isValid()) {
                if (!arrivalMoment.isSame(departureMoment, 'day')) {
                    arrivalDateString = arrivalMoment.format("DDMMM").toUpperCase();
                }
            }

            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber: flightNumRaw,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : '',
                departure: {
                    airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name, country: depAirportInfo.country,
                    time: formatMomentTime(departureMoment, use24hSegment),
                    terminal: normalizeTerminal(depTerminal)
                },
                arrival: {
                    airport: arrAirport,
                    city: arrAirportInfo.city,
                    name: arrAirportInfo.name,
                    country: arrAirportInfo.country,
                    time: formatMomentTime(arrivalMoment, use24hSegment),
                    dateString: arrivalDateString,
                    terminal: normalizeTerminal(arrTerminal)
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: getMealDescription(mealCode),
                notes: [],
                operatedBy: null,
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes,
                formattedNextDepartureTime: formattedNextDepartureTime
            };
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    // --- START: REFINED LOGIC FOR LEG DETECTION (INCLUDING INBOUND/OUTBOUND) ---

    if (flights.length > 0) {
        // Initialize all directions to null or undefined
        for (const flight of flights) {
            flight.direction = null; // or undefined
        }
        
        // The very first flight is always 'OUTBOUND'
        flights[0].direction = 'OUTBOUND';

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

            // Determine the correct format string for the previous flight's arrival time
            // Check if the time string contains 'AM' or 'PM' to infer 12h format
            const prevTimeFormat = prevFlight.arrival.time.includes('M') ? format12h : format24h;
            // Determine the correct format string for the current flight's departure time
            // Check if the time string contains 'AM' or 'PM' to infer 12h format
            const currTimeFormat = currentFlight.departure.time.includes('M') ? format12h : format24h;
            
            // Construct the full arrival date string for the previous flight, handling dateString
            const prevArrivalDatePart = prevFlight.arrival.dateString || moment.tz(prevFlight.date, "dddd, DD MMM YYYY", prevArrAirportInfo.timezone).format("DDMMMYYYY");
            const prevArrivalMomentString = `${prevArrivalDatePart} ${prevFlight.arrival.time}`;

            // Construct the full departure date string for the current flight
            const currentDepartureDatePart = moment.tz(currentFlight.date, "dddd, DD MMM YYYY", currDepAirportInfo.timezone).format("DDMMMYYYY");
            const currentDepartureMomentString = `${currentDepartureDatePart} ${currentFlight.departure.time}`;

            // Use the detected format for parsing
            const arrivalOfPreviousFlight = moment.tz(prevArrivalMomentString, prevTimeFormat, true, prevArrAirportInfo.timezone);
            const departureOfCurrentFlight = moment.tz(currentDepartureMomentString, currTimeFormat, true, currDepAirportInfo.timezone);
            
            if (arrivalOfPreviousFlight.isValid() && departureOfCurrentFlight.isValid()) {
                const stopoverMinutes = departureOfCurrentFlight.diff(arrivalOfPreviousFlight, 'minutes');

                if (stopoverMinutes > STOPOVER_THRESHOLD_MINUTES) {
                    const originalOrigin = flights[0].departure.airport;
                    const finalDestination = flights[flights.length - 1].arrival.airport;
                    
                    // Simple heuristic: if the current flight's origin is the final destination
                    // of the overall trip, and the first flight's origin, it might be inbound.
                    // This can be complex for multi-leg, non-roundtrip journeys.
                    // For a simple round trip (A->B, B->A), this works.

                    // A more robust check might involve comparing the current flight's departure airport
                    // with the original departure airport of the whole trip.
                    // If the current flight departs from the final destination of the outbound journey,
                    // and is heading back towards the original origin, it's a strong candidate for INBOUND.
                    
                    // Let's use a simpler rule for a clear break:
                    // If there's a long stopover, and the current segment's departure airport
                    // is different from the original departure airport (or it's the final destination)
                    // and we haven't already marked it as INBOUND, consider it a new leg.
                    
                    // This is a basic approach. Real-world PNR logic can be very complex.
                    // A common pattern is that the first "long break" signifies the start of the return journey.
                    
                    let isRoundTrip = (originalOrigin === currentFlight.arrival.airport); // Simple check

                    // If the first flight's arrival airport is the same as the current flight's departure airport
                    // AND the current flight's arrival airport is the same as the trip's origin,
                    // it's likely the start of an inbound leg.

                    // More generally, any segment *after* the first long stopover could be considered inbound,
                    // especially if the general direction reverses.

                    // For now, let's just mark it if it's a long stopover and we're potentially heading back.
                    // This needs refinement for complex itineraries.
                    
                    // A pragmatic approach: Assume the first "break" marks the end of outbound, and start of inbound.
                    // This might not be perfect for triangular trips, but covers most round trips.
                    
                    if (flights[i - 1].direction === 'OUTBOUND' && currentFlight.departure.airport !== originalOrigin) {
                        currentFlight.direction = 'INBOUND';
                    } else if (flights[i - 1].direction === 'INBOUND' && currentFlight.departure.airport === originalOrigin) {
                        // This might happen if there's an internal flight on the return leg,
                        // and then another "outbound" flight for another segment.
                        // This case is tricky and depends heavily on how "outbound/inbound" is defined for complex trips.
                        // For simplicity, let's keep it 'INBOUND' once it flips.
                        currentFlight.direction = 'INBOUND'; 
                    } else {
                        // If it's a long stopover but doesn't fit the clear inbound criteria,
                        // it could be a multi-city trip. We'll default to the previous direction
                        // or introduce a 'TRANSFER' / 'MULTI-CITY' concept if needed.
                        currentFlight.direction = flights[i-1].direction || 'UNKNOWN';
                    }
                } else {
                    // Continue the direction from the previous flight if no long stopover
                    currentFlight.direction = prevFlight.direction;
                }
            } else {
                console.error("Moment.js parsing failed! Check formats.");
                console.error(`- Previous Arrival: '${prevArrivalMomentString}' with format '${prevTimeFormat}' in timezone '${prevArrAirportInfo.timezone}'`);
                console.error(`- Current Departure: '${currentDepartureMomentString}' with format '${currTimeFormat}' in timezone '${currDepAirportInfo.timezone}'`);
                currentFlight.direction = 'UNKNOWN'; // Fallback
            }
        }
    }
    // --- END: REFINED LOGIC FOR LEG DETECTION (INCLUDING INBOUND/OUTBOUND) ---

    return { flights, passengers };
}

module.exports = app;
