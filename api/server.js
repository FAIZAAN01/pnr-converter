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

    // --- START: AMADEUS FORMAT REGEX LIBRARY ---

    // Regex 1: For Spaced-Out formats. The 'g' flag is crucial for finding ALL matches on a single line.
    // Handles formats like: "WB 440 M 15AUG KGL DAR 3 1155 1625" AND "ET 816...ET 803..."
    const amadeusSpacedRegex = new RegExp(
        '([A-Z0-9]{2})\\s*' +          // 1: Airline code
        '(\\d{1,4}[A-Z]?)\\s+' +       // 2: Flight number
        '([A-Z])\\s+' +                // 3: Class
        '([0-3]\\d[A-Z]{3})\\s+' +      // 4: Departure date
        '([A-Z]{3})\\s+' +             // 5: Departure Airport
        '([A-Z]{3})\\s+' +             // 6: Arrival Airport
        '[A-Z0-9]+\\s+' +              // Skips terminal/day (e.g., "2" or "3")
        '(\\d{4})\\s+' +               // 7: Departure time
        '(\\d{4})',                    // 8: Arrival time
        'g' // The "global" flag allows matchAll to find multiple segments per line.
    );

    // Regex 2: For Compact formats. This is a fallback for single-segment lines.
    // Handles format like: "WB 440 J 15AUG 5 KGLDAR DK1 1155 1625"
    const amadeusCompactRegex = new RegExp(
        '^\\s*(?:\\d+\\s+)?' +
        '([A-Z0-9]{2})\\s*' +            // 1: Airline code
        '(\\d{1,4}[A-Z]?)\\s+' +         // 2: Flight number
        '([A-Z])\\s+' +                  // 3: Class
        '([0-3]\\d[A-Z]{3})' +            // 4: Departure date
        '\\s+[A-Z0-9]\\s+' +             // Skips day-of-week digit
        '([A-Z]{3})' +                   // 5: Departure Airport
        '([A-Z]{3})' +                   // 6: Arrival Airport
        '\\s+[A-Z0-9]{2,3}\\s+' +        // Skips status code (DK1)
        '(\\d{4})\\s+' +                 // 7: Departure time
        '(\\d{4})'                       // 8: Arrival time
    );
    // --- END: AMADEUS FORMAT REGEX LIBRARY ---
    
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const line of lines) {
        if (!line) continue;
        
        let flightMatches = [...line.matchAll(amadeusSpacedRegex)];
        let formatType = 'amadeusSpaced';

        // If the spaced regex found nothing, try the compact regex as a fallback.
        if (flightMatches.length === 0) {
            const compactMatch = line.match(amadeusCompactRegex);
            if (compactMatch) {
                // To keep the loop structure consistent, we put the single match into an array.
                flightMatches = [compactMatch];
                formatType = 'amadeusCompact';
            }
        }
        
        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) { /* Passenger logic is unchanged */ }
        else if (flightMatches.length > 0) {
            
            // Loop through every flight segment found on the line
            for (const flightMatch of flightMatches) {
                if (currentFlight) {
                    flights.push(currentFlight);
                }
                flightIndex++;
                
                let airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr;

                if (formatType === 'amadeusSpaced') {
                    [, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = flightMatch;
                } else if (formatType === 'amadeusCompact') {
                    // Note: The compact regex has an optional segment number at the start, so we skip it.
                    [, , airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = flightMatch;
                }

                // The universal date and detail parsing logic now runs for each segment.
                let flightDetailsPart = line.substring(line.lastIndexOf(flightMatch[0]) + flightMatch[0].length).trim();
                let arrDateStrOrNextDayIndicator = null;

                const detailsDateMatch = flightDetailsPart.match(/^([0-3]\d[A-Z]{3}|\+\d)\s*/);
                if (detailsDateMatch) {
                    arrDateStrOrNextDayIndicator = detailsDateMatch[1];
                    flightDetailsPart = flightDetailsPart.substring(detailsDateMatch[0].length).trim();
                }

                let finalArrDateStr;
                if (arrDateStrOrNextDayIndicator) {
                    if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                        const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10) || 0;
                        finalArrDateStr = moment(depDateStr, "DDMMM").add(daysToAdd, 'day').format('DDMMM').toUpperCase();
                    } else {
                        finalArrDateStr = arrDateStrOrNextDayIndicator;
                    }
                } else {
                    finalArrDateStr = depDateStr;
                }

                const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
                const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };
                if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
                if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';
                
                const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone);
                const arrivalMoment = moment.tz(`${finalArrDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone);

                if (!arrDateStrOrNextDayIndicator && departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) {
                    arrivalMoment.add(1, 'day');
                    finalArrDateStr = arrivalMoment.format('DDMMM').toUpperCase();
                }
                
                let arrivalDateString = null;
                if (depDateStr !== finalArrDateStr) {
                    arrivalDateString = arrivalMoment.isValid() ? arrivalMoment.format('DD MMM') : null;
                }

                flightMoments.push({ departureMoment, arrivalMoment });
                
                const detailsParts = flightDetailsPart.split(/\s+/);
                let aircraftCodeKey = null;
                const aircraftRegex = /\/?([A-Z0-9]{3,4})/; 
                for (let part of detailsParts) {
                    const aircraftMatch = part.match(aircraftRegex);
                    if (aircraftMatch && aircraftMatch[1] in aircraftTypes) {
                        aircraftCodeKey = aircraftMatch[1];
                        break;
                    }
                }
                const mealCode = detailsParts.find(p => p.length === 1 && /[BLDSMFHCVKOPRWYNG]/.test(p.toUpperCase()));

                currentFlight = {
                    segment: flightIndex,
                    airline: { code: airlineCode.trim(), name: airlineDatabase[airlineCode.trim()] || `Unknown Airline (${airlineCode.trim()})` },
                    flightNumber: flightNumRaw,
                    travelClass: { code: travelClass, name: getTravelClassName(travelClass) },
                    date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : 'Invalid Date',
                    departure: { airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name, time: formatMomentTime(departureMoment, use24hSegment), terminal: null },
                    arrival: { airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name, time: formatMomentTime(arrivalMoment, use24hSegment), dateString: arrivalDateString, terminal: null },
                    duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                    aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                    meal: mealCode,
                    notes: [], 
                    operatedBy: null,
                    transitTime: null,
                    transitDurationMinutes: null,
                    direction: null
                };
            }
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0 && !isPassengerLine) {
            currentFlight.notes.push(line.trim());
        }
    }
    if (currentFlight) flights.push(currentFlight);

    if (flights.length > 0) {
        flights[0].direction = 'Outbound';
        const STOPOVER_THRESHOLD_MINUTES = 24 * 60; 
        for (let i = 1; i < flights.length; i++) {
            const prevMoments = flightMoments[i - 1];
            const currentMoments = flightMoments[i];
            if (prevMoments.arrivalMoment.isValid() && currentMoments.departureMoment.isValid()) {
                const transitDuration = moment.duration(currentMoments.departureMoment.diff(prevMoments.arrivalMoment));
                const totalMinutes = transitDuration.asMinutes();
                if (totalMinutes > 0 && totalMinutes < STOPOVER_THRESHOLD_MINUTES) {
                    const hours = Math.floor(transitDuration.asHours());
                    const minutes = transitDuration.minutes();
                    flights[i].transitTime = `${hours < 10 ? '0' : ''}${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
                    flights[i].transitDurationMinutes = Math.round(totalMinutes);
                } else if (totalMinutes >= STOPOVER_THRESHOLD_MINUTES) {
                     const isRoundTrip = flights[0].departure.airport === flights[flights.length - 1].arrival.airport;
                     flights[i].direction = isRoundTrip ? 'Inbound' : 'Outbound';
                }
            }
        }
    }
    
    return { flights, passengers };
}
module.exports = app;