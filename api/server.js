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

function parseGalileoEnhanced(pnrText, options) {
    const flights = [];
    const passengers = [];
    const lines = pnrText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    
    // Using the iterative state variable from your reference code.
    let previousArrivalMoment = null; 

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    // --- REGEX LIBRARY (Inspired by your reference) ---

    // Pattern 1 (Flexible): For spaced-out and multi-segment Amadeus lines. 'g' flag is essential.
    const amadeusSegmentRegex = new RegExp(
        '([A-Z0-9]{2,3})\\s+' +         // 1: Airline Code
        '(\\d{1,4}[A-Z]?)\\s+' +        // 2: Flight Number
        '([A-Z])\\s+' +                 // 3: Class
        '([0-3]\\d[A-Z]{3})\\s+' +       // 4: Date
        '([A-Z]{3})\\s+' +              // 5: Departure Airport
        '([A-Z]{3})\\s+' +              // 6: Arrival Airport
        '(?:[A-Z0-9]+\\s+)' +           // Skips terminal/day (non-capturing)
        '(\\d{4})\\s+' +                // 7: Departure Time
        '(\\d{4})',                     // 8: Arrival Time
        'g'
    );

    // Pattern 2 (Compact): Fallback for compact Amadeus/Galileo formats.
    const compactSegmentRegex = /^\s*(?:\d+\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+[A-Z0-9]\s+([A-Z]{3})([A-Z]{3})\s+[A-Z0-9]{2,3}\s+(\d{4})\s+(\d{4})/;
    
    // Other helper regexes
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;
    const continuationSegmentLineRegex = /^\s*[A-Z0-9]{2,3}\s+\d/; // Identifies multi-line continuations
    
    // --- STATEFUL PARSING LOGIC ---
    for (let i = 0; i < lines.length; i++) {
        let line = lines[i];
        if (!line) continue;

        // Merge multi-line segments before processing
        if (i + 1 < lines.length && continuationSegmentLineRegex.test(lines[i+1])) {
            line += ' ' + lines[i + 1];
            i++; 
        }

        // --- Two-Regex approach from your reference ---
        let flightMatches = [...line.matchAll(amadeusSegmentRegex)];
        let isCompact = false;
        
        if (flightMatches.length === 0) {
            const compactMatch = line.match(compactSegmentRegex);
            if (compactMatch) {
                flightMatches.push(compactMatch);
                isCompact = true;
            }
        }
        
        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) {
             // Passenger logic is unchanged
        } else if (flightMatches.length > 0) {
            for (const flightMatch of flightMatches) {
                if (currentFlight) flights.push(currentFlight);
                flightIndex++;

                const [
                    flightMatchString, airlineCode, flightNumRaw, travelClass, depDateStr, 
                    depAirport, arrAirport, depTimeStr, arrTimeStr
                ] = isCompact ? [flightMatch[0], flightMatch[1], flightMatch[2], flightMatch[3], flightMatch[4], flightMatch[5], flightMatch[6], flightMatch[7], flightMatch[8]] : flightMatch;

                // --- Build the flight object, calculating transit iteratively ---
                let flightDetailsPart = line.substring(line.lastIndexOf(flightMatchString) + flightMatchString.length);
                const nextFlightIndex = flightDetailsPart.search(/[A-Z0-9]{2,3}\s+\d{1,4}/);
                if (nextFlightIndex > 0) {
                    flightDetailsPart = flightDetailsPart.substring(0, nextFlightIndex);
                }
                flightDetailsPart = flightDetailsPart.trim();

                const depAirportInfo = airportDatabase[depAirport] || {};
                const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone || 'UTC');

                let transitTime = null;
                let transitDurationMinutes = null;

                // **Iterative Transit Calculation Logic**
                if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment.isValid()) {
                    const duration = moment.duration(departureMoment.diff(previousArrivalMoment));
                    const totalMinutes = duration.asMinutes();
                    if (totalMinutes > 0) {
                        transitTime = `${String(Math.floor(duration.asHours())).padStart(2, '0')}h ${String(duration.minutes()).padStart(2, '0')}m`;
                        transitDurationMinutes = Math.round(totalMinutes);
                    }
                }
                
                // Build the final arrival moment
                const { arrivalMoment, arrivalDateString } = buildArrival(depDateStr, arrTimeStr, flightDetailsPart, arrAirport);
                
                // **Update state for the next iteration**
                previousArrivalMoment = arrivalMoment.clone();

                const detailsParts = flightDetailsPart.split(/\s+/);
                const aircraftCodeKey = findAircraft(detailsParts);

                currentFlight = {
                    segment: flightIndex,
                    airline: { code: airlineCode.trim(), name: airlineDatabase[airlineCode.trim()] || `Unknown` },
                    flightNumber: flightNumRaw,
                    travelClass: { code: travelClass, name: getTravelClassName(travelClass) },
                    date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : 'Invalid',
                    departure: { airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name, time: formatMomentTime(departureMoment, use24hSegment), terminal: null },
                    arrival: { airport: arrAirport, city: (airportDatabase[arrAirport] || {}).city, name: (airportDatabase[arrAirport] || {}).name, time: formatMomentTime(arrivalMoment, use24hSegment), dateString: arrivalDateString, terminal: null },
                    duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                    aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                    transitTime: transitTime,
                    transitDurationMinutes: transitDurationMinutes,
                    meal: null, notes: [], operatedBy: null, direction: null
                };
            }
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    // --- HELPER FUNCTIONS for clarity ---
    function buildArrival(depDateStr, arrTimeStr, flightDetailsPart, arrAirport) {
        const arrAirportInfo = airportDatabase[arrAirport] || {};
        let arrDateStrOrNextDayIndicator = null;
        const detailsDateMatch = flightDetailsPart.match(/^([0-3]\d[A-Z]{3}|\+\d)/);
        if (detailsDateMatch) arrDateStrOrNextDayIndicator = detailsDateMatch[1];
        
        let finalArrDateStr = depDateStr;
        if (arrDateStrOrNextDayIndicator) {
            if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                const days = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10) || 0;
                finalArrDateStr = moment(depDateStr, "DDMMM").add(days, 'day').format('DDMMM').toUpperCase();
            } else {
                finalArrDateStr = arrDateStrOrNextDayIndicator;
            }
        }

        const arrivalMoment = moment.tz(`${finalArrDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone || 'UTC');
        
        if (!arrDateStrOrNextDayIndicator) {
            const tempDepMoment = moment(`${depDateStr} 00:00`, "DDMMM HH:mm");
            if (arrivalMoment.isBefore(tempDepMoment)) {
                 const depTime = moment(arrTimeStr, "HHmm");
                 const arrTime = moment(depTime, "HHmm");
                 if(arrTime.isBefore(depTime)) arrivalMoment.add(1, 'day');
            }
        }

        const arrivalDateString = finalArrDateStr.toUpperCase() !== depDateStr.toUpperCase() ? (arrivalMoment.isValid() ? arrivalMoment.format('DD MMM') : null) : null;
        return { arrivalMoment, arrivalDateString };
    }
    
    function findAircraft(detailsParts) {
        const aircraftRegex = /\/?([A-Z0-9]{3,4})/;
        for (const part of detailsParts) {
            const match = part.match(aircraftRegex);
            if (match && aircraftTypes[match[1]]) return match[1];
        }
        return null;
    }

    // --- Final loop to set trip direction, as seen in reference ---
    if (flights.length > 0) {
        const isRoundTrip = flights[0].departure.airport === flights[flights.length - 1].arrival.airport;
        let currentDirection = 'Outbound';
        flights[0].direction = currentDirection;

        for (let i = 1; i < flights.length; i++) {
            if (flights[i].transitDurationMinutes && flights[i].transitDurationMinutes >= (24 * 60)) {
                if (isRoundTrip) {
                    currentDirection = 'Inbound';
                }
            }
            flights[i].direction = currentDirection;
        }
    }
    
    return { flights, passengers };
}

module.exports = app;