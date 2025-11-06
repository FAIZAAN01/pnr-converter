const express = require('express');
// const bodyParser = require('body-parser'); // replaced with express.json/urlencoded
const moment = require('moment-timezone');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const morgan = require('morgan');

/**
 * Safely parses a local airport time string into a Moment object.
 * Handles ambiguous DST times (duplicate 01:00–02:00 hour).
 * @param {string} dateStr - The local date/time string (e.g., "03NOV2024 0130")
 * @param {string} format - The input format (e.g., "DDMMMYYYY HHmm")
 * @param {string} tz - The IANA timezone name (e.g., "America/New_York")
 * @returns {object} moment object with corrected offset
 */
function parseLocalTime(dateStr, format, tz) {
  let m = moment.tz(dateStr, format, tz);

  if (!m.isValid()) return m; // skip invalids

  // Handle ambiguous DST time (e.g., 01:30 appears twice)
  // We detect if shifting -1 hour results in same local clock time
  const minus1 = m.clone().subtract(1, "hour");
  if (minus1.format("HHmm") === m.format("HHmm") && minus1.tz() === tz) {
    // Prefer the *later* occurrence (standard time)
    m.add(1, "hour");
  }

  return m;
}


const app = express();
app.set('trust proxy', 1); // trust first proxy

require('dotenv').config();
const axios = require('axios');

console.log('Loaded Telegram Token:', process.env.TELEGRAM_TOKEN ? '✅ Present' : '❌ Missing');
console.log('Loaded Chat ID:', process.env.TELEGRAM_CHAT_ID ? '✅ Present' : '❌ Missing');

// Simple helper for Telegram alerts
async function sendTelegramAlert(message) {
  try {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
      console.error('Telegram credentials missing in .env');
      return;
    }

    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'Markdown'
    });

    console.log('✅ Telegram alert sent.');
  } catch (err) {
    console.error('❌ Failed to send Telegram alert:', err.message);
  }
}


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
            // --- Detect suspicious/unrecognized PNR results ---
        const resultStr = JSON.stringify(result);
        const suspicious = (
            result.flights.length === 0 ||
            resultStr.includes('Unknown Airline') ||
            resultStr.includes('undefined') ||
            resultStr.includes('Unrecognized')
        );

        if (suspicious) {
            const alertMessage = `
        ⚠️ *PNR Conversion Issue Detected*

        *PNR Input:*
        \`${pnrText}\`

        *Detected Problem:*
        ${result.flights.length === 0 ? 'No flights found' : 'Unrecognized or undefined data'}

        *Snippet:*
        \`${resultStr.slice(0, 500)}...\`
        `;
            sendTelegramAlert(alertMessage);
        }


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

        let line = rawLine.replace(/^\s*\*/, ''); // remove codeshare *

        let flightMatch = line.match(flightSegmentRegexCompact);
        let segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator, depTerminal, arrTerminal;

        if (flightMatch) {
            [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            depTerminal = null;
            arrTerminal = null;
        } else {
            flightMatch = line.match(flightSegmentRegexFlexible);
            if (flightMatch) {
                [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depTerminal, arrAirport, arrTerminal, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            }
        }

        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        // --- Passenger parsing ---
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

        // --- Flight parsing ---
        else if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;

            // Normalize airport info
            const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };

            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

            // --- Year handling ---
            const depDateMoment = moment.utc(depDateStr, "DDMMM");
            const currentDepartureMonthIndex = depDateMoment.month();

            if (currentYear === null) {
                currentYear = new Date().getFullYear();
                const prospectiveDate = depDateMoment.year(currentYear);
                if (prospectiveDate.isBefore(moment().subtract(3, 'months'))) currentYear++;
            } else if (currentDepartureMonthIndex < previousDepartureMonthIndex) {
                currentYear++;
            }
            previousDepartureMonthIndex = currentDepartureMonthIndex;

            // --- Normalize times ---
            const cleanDepTime = depTimeStr.padStart(4, '0');
            const cleanArrTime = arrTimeStr.padStart(4, '0');
            const fullDepDateStr = `${depDateStr}${currentYear}`;

            const departureMoment = parseLocalTime(`${fullDepDateStr} ${cleanDepTime}`, "DDMMMYYYY HHmm", depAirportInfo.timezone);

            // Arrival parsing
            let arrivalMoment;
            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().add(daysToAdd, 'days')
                        .set({ hour: parseInt(cleanArrTime.substring(0, 2)), minute: parseInt(cleanArrTime.substring(2, 4)) });
                } else {
                    arrivalMoment = parseLocalTime(`${arrDateStrOrNextDayIndicator}${currentYear} ${cleanArrTime}`, "DDMMMYYYY HHmm", arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = parseLocalTime(`${depDateStr}${currentYear} ${cleanArrTime}`, "DDMMMYYYY HHmm", arrAirportInfo.timezone);
                if (arrivalMoment.isBefore(departureMoment)) arrivalMoment.add(1, 'day');
            }

            // Transit info
            let precedingTransitTimeForThisSegment = null;
            let transitDurationInMinutes = null;
            let formattedNextDepartureTime = null;

            if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment.isValid()) {
                const transitMinutes = moment.duration(departureMoment.diff(previousArrivalMoment)).asMinutes();
                if (transitMinutes > 30 && transitMinutes < 1440) {
                    const hours = Math.floor(transitMinutes / 60);
                    const minutes = Math.floor(transitMinutes % 60);
                    precedingTransitTimeForThisSegment = `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m`;
                    transitDurationInMinutes = transitMinutes;
                    formattedNextDepartureTime = formatMomentTime(departureMoment, use24hTransit);
                }
            }
            previousArrivalMoment = arrivalMoment.clone();

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
                    airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name, country: arrAirportInfo.country,
                    time: formatMomentTime(arrivalMoment, use24hSegment),
                    dateString: !arrivalMoment.isSame(departureMoment, 'day') ? arrivalMoment.format("DDMMM").toUpperCase() : null,
                    terminal: normalizeTerminal(arrTerminal)
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                aircraft: '', // keep original aircraft parsing logic
                meal: null,  // keep original meal logic
                notes: [],
                operatedBy: operatedByMatch ? operatedByMatch[1].trim() : null,
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes,
                formattedNextDepartureTime
            };
        } else if (currentFlight && line.trim()) {
            currentFlight.notes.push(line.trim());
        }
    }

    if (currentFlight) flights.push(currentFlight);

    // Outbound/Inbound detection (existing logic)
    if (flights.length > 0) {
        flights[0].direction = 'OUTBOUND';
        const STOPOVER_THRESHOLD_MINUTES = 1440;
        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currentFlight = flights[i];
            const prevArrTimezone = airportDatabase[prevFlight.arrival.airport]?.timezone || 'UTC';
            const currDepTimezone = airportDatabase[currentFlight.departure.airport]?.timezone || 'UTC';
            const prevArrMoment = moment.tz(`${prevFlight.arrival.dateString || prevFlight.date.split(', ')[1]} ${prevFlight.arrival.time}`, prevFlight.arrival.time.includes('M') ? "DD MMM YYYY hh:mm A" : "DD MMM YYYY HH:mm", prevArrTimezone);
            const currDepMoment = moment.tz(`${currentFlight.date.split(', ')[1]} ${currentFlight.departure.time}`, currentFlight.departure.time.includes('M') ? "DD MMM YYYY hh:mm A" : "DD MMM YYYY HH:mm", currDepTimezone);
            if (currDepMoment.isValid() && prevArrMoment.isValid()) {
                if (currDepMoment.diff(prevArrMoment, 'minutes') > STOPOVER_THRESHOLD_MINUTES) {
                    currentFlight.direction = 'INBOUND';
                }
            }
        }
    }

    return { flights, passengers };
}

module.exports = app;

console.log(moment.tz.zone('America/New_York'));
