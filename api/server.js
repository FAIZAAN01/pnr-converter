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
    
    const flightMoments = []; 

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    // --- REGEX LIBRARY ---
    // This library uses patterns inspired by your preferred regexes, but adapted for the robust `matchAll` method.
    
    // Pattern 1 (Primary): Based on your "Flexible" regex. The 'g' flag is essential for `matchAll`.
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
        'g' // The "global" flag is what enables it to find ALL matches.
    );

    // Pattern 2 (Fallback): Based on your "Compact" regex, for single-line formats.
    const compactSegmentRegex = /^\s*(?:\d+\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+[A-Z0-9]\s+([A-Z]{3})([A-Z]{3})\s+[A-Z0-9]{2,3}\s+(\d{4})\s+(\d{4})/;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;
    
    // --- STATEFUL PARSING LOGIC ---
    for (const line of lines) {
        if (!line) continue;

        // We use `matchAll` with the flexible pattern to handle single and multi-segment lines.
        const flightMatches = [...line.matchAll(amadeusSegmentRegex)];
        let isCompact = false;
        
        // If the primary pattern finds nothing, we try the compact one as a fallback.
        if (flightMatches.length === 0) {
            const compactMatch = line.match(compactSegmentRegex);
            if (compactMatch) {
                flightMatches.push(compactMatch); // Add the single result to the array to be processed.
                isCompact = true;
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
        else if (flightMatches.length > 0) {
            // This loop correctly processes EVERY flight found on the line.
            for (const flightMatch of flightMatches) {
                if (currentFlight) flights.push(currentFlight);
                flightIndex++;

                // Destructure the captured data. Note the different group indices for the compact regex.
                const [
                    , // Full match string
                    airlineCode, flightNumRaw, travelClass, depDateStr, 
                    depAirport, arrAirport, depTimeStr, arrTimeStr
                ] = isCompact ? [flightMatch[0], flightMatch[1], flightMatch[2], flightMatch[3], flightMatch[4], flightMatch[5], flightMatch[6], flightMatch[7], flightMatch[8]] : flightMatch;

                // Create the flight object using the robust helper function.
                currentFlight = buildFlightObject({ flightIndex, line, flightMatchString: flightMatch[0], depDateStr, arrTimeStr, airlineCode, flightNumRaw, travelClass, depAirport, arrAirport, depTimeStr });
            }
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    // --- HELPER FUNCTION: This contains the universal logic to build a flight object ---
    function buildFlightObject(data) {
        const { flightIndex, line, flightMatchString, depDateStr, arrTimeStr, ...flightData } = data;
        
        let flightDetailsPart = line.substring(line.indexOf(flightMatchString) + flightMatchString.length);
        const nextFlightIndex = flightDetailsPart.search(/[A-Z0-9]{2,3}\s+\d{1,4}/);
        if (nextFlightIndex > 0) {
            flightDetailsPart = flightDetailsPart.substring(0, nextFlightIndex).trim();
        } else {
            flightDetailsPart = flightDetailsPart.trim();
        }

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

        const depAirportInfo = airportDatabase[flightData.depAirport] || {};
        const arrAirportInfo = airportDatabase[flightData.arrAirport] || {};
        const departureMoment = moment.tz(`${depDateStr} ${flightData.depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone || 'UTC');
        const arrivalMoment = moment.tz(`${finalArrDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone || 'UTC');

        if (!arrDateStrOrNextDayIndicator && departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) {
            arrivalMoment.add(1, 'day');
            finalArrDateStr = arrivalMoment.format('DDMMM').toUpperCase();
        }
        
        let arrivalDateString = depDateStr !== finalArrDateStr ? (arrivalMoment.isValid() ? arrivalMoment.format('DD MMM') : null) : null;

        flightMoments.push({ departureMoment, arrivalMoment });
        
        const detailsParts = flightDetailsPart.split(/\s+/);
        let aircraftCodeKey = null;
        const aircraftRegex = /\/?([A-Z0-9]{3,4})/;
        for (const part of detailsParts) {
            const match = part.match(aircraftRegex);
if (match && match[1] in aircraftTypes) { aircraftCodeKey = match[1]; break; }
        }
        
        return {
            segment: flightIndex,
            airline: { code: flightData.airlineCode.trim(), name: airlineDatabase[flightData.airlineCode.trim()] || `Unknown` },
            flightNumber: flightData.flightNumRaw,
            travelClass: { code: flightData.travelClass, name: getTravelClassName(flightData.travelClass) },
            date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : 'Invalid',
            departure: { airport: flightData.depAirport, city: depAirportInfo.city, name: depAirportInfo.name, time: formatMomentTime(departureMoment, use24hSegment), terminal: null },
            arrival: { airport: flightData.arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name, time: formatMomentTime(arrivalMoment, use24hSegment), dateString: arrivalDateString, terminal: null },
            duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
            aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
            meal: null, notes: [], operatedBy: null, transitTime: null, transitDurationMinutes: null, direction: null
        };
    }

    if (flights.length > 0) {
        flights[0].direction = 'Outbound';
        for (let i = 1; i < flights.length; i++) {
            const prev = flightMoments[i - 1]; const curr = flightMoments[i];
            if (prev.arrivalMoment.isValid() && curr.departureMoment.isValid()) {
                const duration = moment.duration(curr.departureMoment.diff(prev.arrivalMoment));
                const totalMinutes = duration.asMinutes();
                if (totalMinutes > 0 && totalMinutes < (24 * 60)) {
                    flights[i].transitTime = `${String(Math.floor(duration.asHours())).padStart(2, '0')}h ${String(duration.minutes()).padStart(2, '0')}m`;
                }
            }
        }
    }
    
    return { flights, passengers };
}
module.exports = app;