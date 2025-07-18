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
    let previousArrivalMoment = null;

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    const flightSegmentRegexCompact = /^\s*(\d+)\s+([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;
    
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const line of lines) {
        if (!line) continue;
        
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
            
            // --- START: MODIFICATION FOR MULTI-CHARACTER MEAL CODES ---
            // Define a regex that matches strings containing only valid IATA meal characters.
            // This now supports single codes ('M'), multi-character codes ('MC'), and special meal codes. [3]
            const validMealCharsRegex = /^[BLDSMFHCVKOPRWYNG]+$/i;
            // Find a part in the remaining line details that matches our meal code pattern.
            const mealCode = detailsParts.find(p => validMealCharsRegex.test(p));
            // --- END: MODIFICATION FOR MULTI-CHARACTER MEAL CODES ---
            
            const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
            const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };
            if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';
            const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, "DDMMM HHmm", true, depAirportInfo.timezone);
            let arrivalMoment;

            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone).add(daysToAdd, 'day');
                } else {
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, "DDMMM HHmm", true, arrAirportInfo.timezone);
                if (departureMoment.isValid() && arrivalMoment.isValid() && arrivalMoment.isBefore(departureMoment)) arrivalMoment.add(1, 'day');
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
            if (departureMoment.isValid() && arrivalMoment.isValid() && !arrivalMoment.isSame(departureMoment, 'day')) {
                arrivalDateString = arrivalMoment.format('DD MMM');
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
                    terminal: depTerminal || null
                },
                arrival: { 
                    airport: arrAirport, city: arrAirportInfo.city, name: arrAirportInfo.name,
                    time: formatMomentTime(arrivalMoment, use24hSegment),
                    dateString: arrivalDateString,
                    terminal: arrTerminal || null
                },
                duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: mealCode || null, // Assign the found meal code
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

    if (flights.length > 0) {
        for (const flight of flights) {
            flight.direction = null; 
        }
        flights[0].direction = 'Outbound';

        const STOPOVER_THRESHOLD_MINUTES = 1440;

        const format12h = "DD MMM YYYY hh:mm A";
        const format24h = "DD MMM YYYY HH:mm";

        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currentFlight = flights[i];

            const prevArrAirportInfo = airportDatabase[prevFlight.arrival.airport] || { timezone: 'UTC' };
            if (!moment.tz.zone(prevArrAirportInfo.timezone)) prevArrAirportInfo.timezone = 'UTC';
            
            const currDepAirportInfo = airportDatabase[currentFlight.departure.airport] || { timezone: 'UTC' };
            if (!moment.tz.zone(currDepAirportInfo.timezone)) currDepAirportInfo.timezone = 'UTC';

            const prevTimeFormat = prevFlight.arrival.time.includes('M') ? format12h : format24h;
            const currTimeFormat = currentFlight.departure.time.includes('M') ? format12h : format24h;

            const prevYear = prevFlight.date.split(', ')[1].split(' ')[2];
            const prevArrivalDateStr = prevFlight.arrival.dateString ? `${prevFlight.arrival.dateString} ${prevYear}` : prevFlight.date.split(', ')[1];
            
            const arrivalOfPreviousFlight = moment.tz(`${prevArrivalDateStr} ${prevFlight.arrival.time}`, prevTimeFormat, true, prevArrAirportInfo.timezone);
            const departureOfCurrentFlight = moment.tz(`${currentFlight.date.split(', ')[1]} ${currentFlight.departure.time}`, currTimeFormat, true, currDepAirportInfo.timezone);

            if (arrivalOfPreviousFlight.isValid() && departureOfCurrentFlight.isValid()) {
                const stopoverMinutes = departureOfCurrentFlight.diff(arrivalOfPreviousFlight, 'minutes');

                if (stopoverMinutes > STOPOVER_THRESHOLD_MINUTES) {
                    const originalOrigin = flights[0].departure.airport;
                    const finalDestination = flights[flights.length - 1].arrival.airport;
                    const isRoundTrip = originalOrigin === finalDestination;

                    currentFlight.direction = isRoundTrip ? 'Inbound' : 'Outbound';
                }
            } else {
                console.error("Moment.js parsing failed! Check formats.");
                console.error(`- Previous Arrival: '${prevFlight.arrival.time}' with format '${prevTimeFormat}'`);
                console.error(`- Current Departure: '${currentFlight.departure.time}' with format '${currTimeFormat}'`);
            }
        }
    }

    return { flights, passengers };
}
module.exports = app;