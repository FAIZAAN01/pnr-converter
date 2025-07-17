const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const morgan = 'morgan';

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
    message: { success: false, error: "Too many requests, please try again later.", result: { flights: [] } }
});

app.post('/api/convert', (req, res) => {
    try {
        const { pnrText, options } = req.body;
        
        const pnrTextForProcessing = pnrText || '';
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
        return res.status(400).json({ success: false, error: err.message, result: { flights: [] } });
    }
});


app.post('/api/upload-logo', limiter, async (req, res) => {
    console.error("Logo upload is not supported on Vercel's read-only filesystem.");
    return res.status(400).json({ success: false, error: "This feature is disabled on the live deployment." });
});

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
    const economyCodes = ['Y', 'B', 'H', 'K', 'L', 'M', 'N', 'O', 'Q', 'S', 'U', 'V', 'X', 'G','W', 'E', 'T','R'];
    if (firstCodes.includes(code)) return 'First';
    if (businessCodes.includes(code)) return 'Business';
    if (premiumEconomyCodes.includes(code)) return 'Premium Economy';
    if (economyCodes.includes(code)) return 'Economy';
    return `Class ${code}`;
}

// PASTE THIS ENTIRE FUNCTION OVER YOUR OLD ONE IN server.js

// PASTE THIS ENTIRE FUNCTION OVER YOUR OLD ONE IN server.js

function parseGalileoEnhanced(pnrText, options) {
    const flights = [];
    const passengers = [];
    const lines = pnrText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    
    const flightMoments = []; 

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    // This robust regex correctly captures the core data from multiple Galileo formats.
    const flightSegmentRegex = new RegExp(
        '^\\s*(?:(\\d+)\\s+)?' +       // 1: Optional segment number
        '([A-Z0-9]{2})\\s*' +          // 2: Airline code
        '(\\d{1,4}[A-Z]?)' +           // 3: Flight number
        '\\s+([A-Z])' +                // 4: Class of service
        '\\s+([0-3]\\d[A-Z]{3})' +      // 5: Departure date (e.g., 18JUL)
        '\\s+\\S+\\s+' +               // Skips day-of-week & status (e.g., " 5 ")
        '([A-Z]{3})' +                 // 6: Departure Airport
        '([A-Z]{3})' +                 // 7: Arrival Airport
        '\\s+\\S+\\s+' +               // Skips status code (e.g., " DK1 ")
        '(\\d{4})\\s+' +               // 8: Departure time
        '(\\d{4})'                     // 9: Arrival time
    );
    
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const line of lines) {
        if (!line) continue;
        
        const flightMatch = line.match(flightSegmentRegex);
        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) {
            // Passenger parsing logic remains unchanged...
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
            
            const [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = flightMatch;
            
            // --- START: NEW RELIABLE DATE LOGIC ---

            // 1. Isolate the details that come AFTER the main regex match.
            let flightDetailsPart = line.substring(flightMatch[0].length).trim();
            let arrDateStrOrNextDayIndicator = null;

            // 2. Look for an explicit arrival date in those details first. This is our "real data".
            const detailsDateMatch = flightDetailsPart.match(/^([0-3]\d[A-Z]{3}|\+\d)\s*/);
            if (detailsDateMatch) {
                arrDateStrOrNextDayIndicator = detailsDateMatch[1];
                // Remove the date from the details string so we don't parse it again.
                flightDetailsPart = flightDetailsPart.substring(detailsDateMatch[0].length).trim();
            }

            // 3. Get all timezone and airport info.
            const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };
            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';
            
            // 4. Create the authoritative departure moment. This is always correct.
            const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone);
            
            let arrivalMoment;

            // 5. Build the arrival moment based on the "real data" principle.
            if (arrDateStrOrNextDayIndicator) {
                // PATH A: The PNR provided an explicit date or day indicator. This is the truth.
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    // Case: "+1"
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10) || 0;
                    arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone).add(daysToAdd, 'day');
                } else {
                    // Case: "19JUL"
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                // PATH B: The PNR did NOT provide an arrival date. This is the ONLY time we apply logic.
                // We start by assuming it arrives on the same day as departure.
                arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone);
                
                // Now we check if that is physically possible.
                // Comparing the full date-time objects is the most reliable way.
                if (departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) {
                    // If the arrival is before departure, it must be the next day.
                    arrivalMoment.add(1, 'day');
                }
            }
            
            // --- END: NEW RELIABLE DATE LOGIC ---
            
            flightMoments.push({ departureMoment, arrivalMoment });

            // The rest of the parsing logic uses these authoritative moments.
            const detailsParts = flightDetailsPart.split(/\s+/);
            let aircraftCodeKey = null;
            for (let part of detailsParts) {
                let potentialCode = part.toUpperCase();
                if (potentialCode.includes('/')) potentialCode = potentialCode.split('/').pop();
                if (potentialCode in aircraftTypes) {
                    aircraftCodeKey = potentialCode;
                    break;
                }
            }
            const mealCode = detailsParts.find(p => p.length === 1 && /[BLDSMFHCVKOPRWYNG]/.test(p.toUpperCase()));

            let arrivalDateString = null;
            if (departureMoment.isValid() && arrivalMoment.isValid() && !arrivalMoment.isSame(departureMoment, 'day')) {
                arrivalDateString = arrivalMoment.format('DD MMM');
            }
            
            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                flightNumber: flightNumRaw,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : 'Invalid Date',
                departure: { 
                    airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name,
                    time: formatMomentTime(departureMoment, use24hSegment),
                    terminal: null
                },
                arrival: { 
                    airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name,
                    time: formatMomentTime(arrivalMoment, use24hSegment),
                    dateString: arrivalDateString,
                    terminal: null
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: mealCode,
                notes: [], 
                operatedBy: null,
                transitTime: null,
                transitDurationMinutes: null,
                direction: null
            };
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0 && !isPassengerLine) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    // This logic for transit and direction remains the same as it relies on the accurate moments created above.
    if (flights.length > 0) {
        flights[0].direction = 'Outbound';
        const STOPOVER_THRESHOLD_MINUTES = 24 * 60; 
        for (let i = 1; i < flights.length; i++) {
            const prevMoments = flightMoments[i - 1];
            const currentMoments = flightMoments[i];
            if (prevMoments.arrivalMoment.isValid() && currentMoments.departureMoment.isValid()) {
                const transitDuration = moment.duration(currentMoments.departureMoment.diff(prevMoments.arrivalMoment));
                const totalMinutes = transitDuration.asMinutes();
                if (totalMinutes > 0) {
                    const hours = Math.floor(transitDuration.asHours());
                    const minutes = transitDuration.minutes();
                    flights[i].transitTime = `${hours < 10 ? '0' : ''}${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
                    flights[i].transitDurationMinutes = Math.round(totalMinutes);
                }
                if (totalMinutes > STOPOVER_THRESHOLD_MINUTES) {
                    const isRoundTrip = flights[0].departure.airport === flights[flights.length - 1].arrival.airport;
                    flights[i].direction = isRoundTrip ? 'Inbound' : 'Outbound';
                }
            }
        }
    }

    return { flights, passengers };
}
module.exports = app;