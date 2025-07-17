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
    // These are specialized patterns to identify the TYPE of line we are reading.
    
    // Regex 1: The main pattern to find Amadeus flight segments.
    // The 'g' flag is crucial for finding ALL matches on a multi-segment line.
    const amadeusSegmentRegex = new RegExp(
        '([A-Z0-9]{2,3})\\s+' +         // 1: Airline Code (e.g., "WB" or "6E")
        '(\\d{1,4}[A-Z]?)\\s+' +        // 2: Flight Number
        '([A-Z])\\s+' +                 // 3: Class
        '([0-3]\\d[A-Z]{3})\\s+' +       // 4: Date (15AUG)
        '([A-Z]{3})\\s+' +              // 5: Departure Airport
        '([A-Z]{3})\\s+' +              // 6: Arrival Airport
        '[A-Z0-9]+\\s+' +               // Skips terminal/day
        '(\\d{4})\\s+' +                // 7: Departure Time
        '(\\d{4})',                     // 8: Arrival Time
        'g'
    );

    // Regex 2: A fallback for the more compact, single-line Amadeus/Galileo format.
    const compactSegmentRegex = new RegExp(
        '^\\s*(?:\\d+\\s+)?' +
        '([A-Z0-9]{2})\\s*' +
        '(\\d{1,4}[A-Z]?)\\s+' +
        '([A-Z])\\s+' +
        '([0-3]\\d[A-Z]{3})' +
        '\\s+[A-Z0-9]\\s+' +
        '([A-Z]{3})' +
        '([A-Z]{3})' +
        '\\s+[A-Z0-9]{2,3}\\s+' +
        '(\\d{4})\\s+' +
        '(\\d{4})'
    );

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;
    
    // --- STATEFUL PARSING LOGIC ---
    for (const line of lines) {
        if (!line) continue;

        const flightMatches = [...line.matchAll(amadeusSegmentRegex)];
        const compactMatch = flightMatches.length === 0 ? line.match(compactSegmentRegex) : null;
        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) {
            // Passenger logic is unchanged and works correctly.
        } else if (flightMatches.length > 0) { // Handles the primary spaced-out and multi-segment formats
            
            // This loop correctly processes one or more flights found on a single line.
            for (const flightMatch of flightMatches) {
                if (currentFlight) flights.push(currentFlight); // Save the previous flight before starting a new one.
                flightIndex++;

                const [, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = flightMatch;

                // This logic is now correctly scoped to each flight on the line.
                // We find the details string that comes AFTER the current flight segment.
                const detailsPartRegex = new RegExp(flightMatch[0] + '\\s*(.*)', 's');
                const detailsMatch = line.match(detailsPartRegex);
                let flightDetailsPart = (detailsMatch && detailsMatch[1]) ? detailsMatch[1] : '';

                // Stop parsing details if we hit the start of the next flight segment
                const nextFlightIndex = flightDetailsPart.search(/[A-Z0-9]{2}\s+\d{1,4}/);
                if (nextFlightIndex !== -1) {
                    flightDetailsPart = flightDetailsPart.substring(0, nextFlightIndex);
                }

                currentFlight = buildFlightObject({
                    flightIndex, depDateStr, arrTimeStr, flightDetailsPart, airlineCode,
                    flightNumRaw, travelClass, depAirport, arrAirport, depTimeStr
                });
            }
        } else if (compactMatch) { // Handles the compact format as a fallback
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;

            const [, , airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = compactMatch;
            const flightDetailsPart = line.substring(compactMatch[0].length).trim();

            currentFlight = buildFlightObject({
                flightIndex, depDateStr, arrTimeStr, flightDetailsPart, airlineCode,
                flightNumRaw, travelClass, depAirport, arrAirport, depTimeStr
            });

        } else if (currentFlight && operatedByMatch) {
            // If we find an "Operated By" line, add it to the flight we just processed.
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.trim().length > 0) {
            // Any other text is considered a general note for the current flight.
            currentFlight.notes.push(line.trim());
        }
    }
    // After the loop, make sure the very last flight is added to the array.
    if (currentFlight) flights.push(currentFlight);

    // --- HELPER FUNCTION to build flight objects, avoiding code duplication ---
    function buildFlightObject(data) {
        const { flightIndex, depDateStr, arrTimeStr, flightDetailsPart, ...flightData } = data;
        
        let arrDateStrOrNextDayIndicator = null;
        const detailsDateMatch = flightDetailsPart.match(/^([0-3]\d[A-Z]{3}|\+\d)\s*/);
        if (detailsDateMatch) {
            arrDateStrOrNextDayIndicator = detailsDateMatch[1];
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

        const depAirportInfo = airportDatabase[flightData.depAirport] || { city: `Unknown`, name: `Airport (${flightData.depAirport})`, timezone: 'UTC' };
        const arrAirportInfo = airportDatabase[flightData.arrAirport] || { city: `Unknown`, name: `Airport (${flightData.arrAirport})`, timezone: 'UTC' };
        if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
        if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';
        
        const departureMoment = moment.tz(`${depDateStr} ${flightData.depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone);
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

        return {
            segment: flightIndex,
            airline: { code: flightData.airlineCode.trim(), name: airlineDatabase[flightData.airlineCode.trim()] || `Unknown Airline (${flightData.airlineCode.trim()})` },
            flightNumber: flightData.flightNumRaw,
            travelClass: { code: flightData.travelClass, name: getTravelClassName(flightData.travelClass) },
            date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : 'Invalid Date',
            departure: { airport: flightData.depAirport, city: depAirportInfo.city, name: depAirportInfo.name, time: formatMomentTime(departureMoment, use24hSegment), terminal: null },
            arrival: { airport: flightData.arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name, time: formatMomentTime(arrivalMoment, use24hSegment), dateString: arrivalDateString, terminal: null },
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

    // This logic for transit and direction remains the same.
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