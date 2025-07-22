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
    return `${hours.toString().padStart(2, '0')}h ${minutes.toString().padStart(2, '0')}m`;
}

function getTravelClassName(classCode) {
    if (!classCode) return 'Unknown';
    const code = classCode.toUpperCase();
    const first = ['F', 'A'];
    const business = ['J', 'C', 'D', 'I', 'Z', 'P'];
    const economy = ['Y', 'B', 'H', 'K', 'L', 'M', 'N', 'O', 'Q', 'S', 'U', 'V', 'X', 'G', 'W', 'E', 'T', 'R'];
    if (first.includes(code)) return 'First';
    if (business.includes(code)) return 'Business';
    if (economy.includes(code)) return 'Economy';
    return `Class ${code}`;
}

function getMealDescription(mealCode) {
    if (!mealCode) return null;
    const map = {
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
    const codes = mealCode.toUpperCase().split('');
    const descs = [...new Set(codes.map(c => map[c] || `Unknown(${c})`))];
    return descs.join(' & ');
}

function parseGalileoEnhanced(pnrText, options) {
    options = options || {};
    const rawText = (pnrText || '').toUpperCase();
    const flights = [];
    const passengers = [];
    const lines = rawText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    let previousArrivalMoment = null;

    const regex = /^\s*(?:(\d+)\s+)?(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\d*\*?([A-Z]{3})\s*([A-Z]{3})\s*\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}|\+\d))?\s+E?\s*\d*\s*([A-Z0-9]{2,4})\s*([A-Z]+)?$/i;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const line of lines) {
        if (!line) continue;

        const flightMatch = line.match(regex);
        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);

        if (isPassengerLine) {
            const cleaned = line.replace(/^\s*\d+\.\s*/, '');
            const blocks = cleaned.split(/\s+\d+\.\s*/);
            for (const b of blocks) {
                const parts = b.trim().split('/');
                if (parts.length >= 2) {
                    const last = parts[0];
                    let rest = parts[1];
                    let title = '';
                    const split = rest.split(/\s+/);
                    if (['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'CHD', 'INF'].includes(split.at(-1)))
                        title = split.pop();
                    const given = split.join(' ');
                    let formatted = `${last}/${given}` + (title ? ` ${title}` : '');
                    if (!passengers.includes(formatted)) passengers.push(formatted);
                }
            }
        } else if (flightMatch) {
            if (currentFlight) flights.push(currentFlight);
            flightIndex++;

            let [
                , segNum, operatedCarrier, airline, flightNum, travelClass,
                depDate, depAp, arrAp, depTime, arrTime, arrDateOrPlus,
                equipment, mealCode
            ] = flightMatch;

            const depInfo = airportDatabase[depAp] || { city: 'Unknown', name: `Airport (${depAp})`, timezone: 'UTC' };
            const arrInfo = airportDatabase[arrAp] || { city: 'Unknown', name: `Airport (${arrAp})`, timezone: 'UTC' };
            if (!moment.tz.zone(depInfo.timezone)) depInfo.timezone = 'UTC';
            if (!moment.tz.zone(arrInfo.timezone)) arrInfo.timezone = 'UTC';

            const depMoment = moment.tz(`${depDate} ${depTime}`, 'DDMMM HHmm', true, depInfo.timezone);
            let arrMoment;
            if (arrDateOrPlus) {
                if (arrDateOrPlus.startsWith('+')) {
                    arrMoment = depMoment.clone().add(parseInt(arrDateOrPlus.slice(1)), 'days').hour(arrTime.slice(0, 2)).minute(arrTime.slice(2, 4));
                } else {
                    arrMoment = moment.tz(`${arrDateOrPlus} ${arrTime}`, 'DDMMM HHmm', true, arrInfo.timezone);
                }
            } else {
                arrMoment = moment.tz(`${depDate} ${arrTime}`, 'DDMMM HHmm', true, arrInfo.timezone);
                if (arrMoment.isSameOrBefore(depMoment)) arrMoment.add(1, 'day');
            }

            let precedingTransit = null, transitMins = null, formattedNextDep = null;
            if (previousArrivalMoment && depMoment.isValid()) {
                const diffMins = depMoment.diff(previousArrivalMoment, 'minutes');
                if (diffMins > 30 && diffMins < 1440) {
                    const h = Math.floor(diffMins / 60), m = diffMins % 60;
                    precedingTransit = `${h.toString().padStart(2, '0')}h ${m.toString().padStart(2, '0')}m`;
                    transitMins = diffMins;
                    formattedNextDep = formatMomentTime(depMoment, options.segmentTimeFormat === '24h');
                }
            }

            let arrivalDateString = arrMoment.isValid() && !arrMoment.isSame(depMoment, 'day')
                ? arrMoment.format('DD MMM') : null;

            currentFlight = {
                segment: parseInt(segNum, 10) || flightIndex,
                operatedCarrier: operatedCarrier || null,
                airline: { code: airline, name: airlineDatabase[airline] || `Unknown (${airline})` },
                flightNumber: flightNum,
                travelClass: { code: travelClass, name: getTravelClassName(travelClass) },
                date: depMoment.isValid() ? depMoment.format('dddd, DD MMM YYYY') : '',
                departure: {
                    airport: depAp, city: depInfo.city, name: depInfo.name,
                    time: formatMomentTime(depMoment, options.segmentTimeFormat === '24h'),
                },
                arrival: {
                    airport: arrAp, city: arrInfo.city, name: arrInfo.name,
                    time: formatMomentTime(arrMoment, options.segmentTimeFormat === '24h'),
                    dateString: arrivalDateString
                },
                duration: calculateAndFormatDuration(depMoment, arrMoment),
                aircraft: aircraftTypes[equipment] || equipment || '',
                meal: getMealDescription(mealCode),
                notes: [],
                transitTime: precedingTransit,
                transitDurationMinutes: transitMins,
                formattedNextDepartureTime: formattedNextDep
            };

            previousArrivalMoment = arrMoment;
        } else if (currentFlight && operatedByMatch) {
            currentFlight.operatedBy = operatedByMatch[1].trim();
        } else if (currentFlight && line.length > 0) {
            currentFlight.notes.push(line);
        }
    }

    if (currentFlight) flights.push(currentFlight);
    return { flights, passengers };
}

app.use('/api', limiter);

app.post('/api/convert', (req, res) => {
    try {
        const { pnrText, options } = req.body;
        const result = parseGalileoEnhanced(pnrText, options);
        res.status(200).json({ success: true, result });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message, result: { flights: [] } });
    }
});

app.listen(4000, () => console.log('Server running on port 4000'));
