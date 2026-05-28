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
const STATION_DATABASE_FILE = path.join(DATA_DIR, 'stationdatabase.json');
const BUS_STATION_DATABASE_FILE = path.join(DATA_DIR, 'busStationData.json');

app.use(express.json());

let airlineDatabase = {};
let aircraftTypes = {};
let airportDatabase = {};
let stationDatabase = {};
let busStationDatabase = {};

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
    stationDatabase = loadDbFromFile(STATION_DATABASE_FILE, {});
    busStationDatabase = loadDbFromFile(BUS_STATION_DATABASE_FILE, {});
}

function lookupLocationData(code, useStationData, useBusStationData) {
    const airportRecord = airportDatabase[code];
    if (airportRecord) {
        return airportRecord;
    }

    if (useBusStationData) {
        const busRecord = busStationDatabase[code];
        if (busRecord) return busRecord;

        return {
            city: 'Unknown',
            name: `Bus Station (${code})`,
            timezone: 'UTC',
            countryCode: '',
            country: ''
        };
    }

    if (useStationData) {
        const stationRecord = stationDatabase[code];
        if (stationRecord) return stationRecord;

        return {
            city: 'Unknown',
            name: `Station (${code})`,
            timezone: 'UTC',
            countryCode: '',
            country: ''
        };
    }

    return {
        city: 'Unknown',
        name: `Airport (${code})`,
        timezone: 'UTC',
        countryCode: '',
        country: ''
    };
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

app.get('/api/currencies', limiter, (req, res) => {
    const currencies = [
        { code: "AED", name: "United Arab Emirates Dirham", symbol: "د.إ" },
        { code: "AFN", name: "Afghan Afghani", symbol: "؋" },
        { code: "ALL", name: "Albanian Lek", symbol: "L" },
        { code: "AMD", name: "Armenian Dram", symbol: "֏" },
        { code: "ANG", name: "Netherlands Antillean Guilder", symbol: "ƒ" },
        { code: "AOA", name: "Angolan Kwanza", symbol: "Kz" },
        { code: "ARS", name: "Argentine Peso", symbol: "$" },
        { code: "AUD", name: "Australian Dollar", symbol: "$" },
        { code: "AWG", name: "Aruban Florin", symbol: "ƒ" },
        { code: "AZN", name: "Azerbaijani Manat", symbol: "₼" },
        { code: "BAM", name: "Bosnia-Herzegovina Convertible Mark", symbol: "KM" },
        { code: "BBD", name: "Barbadian Dollar", symbol: "$" },
        { code: "BDT", name: "Bangladeshi Taka", symbol: "৳" },
        { code: "BGN", name: "Bulgarian Lev", symbol: "лв" },
        { code: "BHD", name: "Bahraini Dinar", symbol: ".د.ب" },
        { code: "BIF", name: "Burundian Franc", symbol: "FBu" },
        { code: "BMD", name: "Bermudan Dollar", symbol: "$" },
        { code: "BND", name: "Bruneian Dollar", symbol: "$" },
        { code: "BOB", name: "Bolivian Boliviano", symbol: "Bs." },
        { code: "BRL", name: "Brazilian Real", symbol: "R$" },
        { code: "BSD", name: "Bahamian Dollar", symbol: "$" },
        { code: "BTN", name: "Bhutanese Ngultrum", symbol: "Nu." },
        { code: "BWP", name: "Botswana Pula", symbol: "P" },
        { code: "BYN", name: "Belarusian Ruble", symbol: "Br" },
        { code: "BZD", name: "Belize Dollar", symbol: "$" },
        { code: "CAD", name: "Canadian Dollar", symbol: "$" },
        { code: "CDF", name: "Congolese Franc", symbol: "FC" },
        { code: "CHF", name: "Swiss Franc", symbol: "CHF" },
        { code: "CLP", name: "Chilean Peso", symbol: "$" },
        { code: "CNY", name: "Chinese Yuan", symbol: "¥" },
        { code: "COP", name: "Colombian Peso", symbol: "$" },
        { code: "CRC", name: "Costa Rican Colón", symbol: "₡" },
        { code: "CUP", name: "Cuban Peso", symbol: "$" },
        { code: "CVE", name: "Cape Verdean Escudo", symbol: "$" },
        { code: "CZK", name: "Czech Koruna", symbol: "Kč" },
        { code: "DJF", name: "Djiboutian Franc", symbol: "Fdj" },
        { code: "DKK", name: "Danish Krone", symbol: "kr" },
        { code: "DOP", name: "Dominican Peso", symbol: "$" },
        { code: "DZD", name: "Algerian Dinar", symbol: "د.ج" },
        { code: "EGP", name: "Egyptian Pound", symbol: "£" },
        { code: "ERN", name: "Eritrean Nakfa", symbol: "Nfk" },
        { code: "ETB", name: "Ethiopian Birr", symbol: "Br" },
        { code: "EUR", name: "Euro", symbol: "€" },
        { code: "FJD", name: "Fijian Dollar", symbol: "$" },
        { code: "FKP", name: "Falkland Islands Pound", symbol: "£" },
        { code: "GBP", name: "British Pound Sterling", symbol: "£" },
        { code: "GEL", name: "Georgian Lari", symbol: "₾" },
        { code: "GHS", name: "Ghanaian Cedi", symbol: "GH₵" },
        { code: "GIP", name: "Gibraltar Pound", symbol: "£" },
        { code: "GMD", name: "Gambian Dalasi", symbol: "D" },
        { code: "GNF", name: "Guinean Franc", symbol: "FG" },
        { code: "GTQ", name: "Guatemalan Quetzal", symbol: "Q" },
        { code: "GYD", name: "Guyanaese Dollar", symbol: "$" },
        { code: "HKD", name: "Hong Kong Dollar", symbol: "$" },
        { code: "HNL", name: "Honduran Lempira", symbol: "L" },
        { code: "HRK", name: "Croatian Kuna", symbol: "kn" },
        { code: "HTG", name: "Haitian Gourde", symbol: "G" },
        { code: "HUF", name: "Hungarian Forint", symbol: "Ft" },
        { code: "IDR", name: "Indonesian Rupiah", symbol: "Rp" },
        { code: "ILS", name: "Israeli New Shekel", symbol: "₪" },
        { code: "INR", name: "Indian Rupee", symbol: "₹" },
        { code: "IQD", name: "Iraqi Dinar", symbol: "ع.د" },
        { code: "IRR", name: "Iranian Rial", symbol: "﷼" },
        { code: "ISK", name: "Icelandic Króna", symbol: "kr" },
        { code: "JMD", name: "Jamaican Dollar", symbol: "J$" },
        { code: "JOD", name: "Jordanian Dinar", symbol: "د.ا" },
        { code: "JPY", name: "Japanese Yen", symbol: "¥" },
        { code: "KES", name: "Kenyan Shilling", symbol: "KSh" },
        { code: "KGS", name: "Kyrgystani Som", symbol: "с" },
        { code: "KHR", name: "Cambodian Riel", symbol: "៛" },
        { code: "KMF", name: "Comorian Franc", symbol: "CF" },
        { code: "KPW", name: "North Korean Won", symbol: "₩" },
        { code: "KRW", name: "South Korean Won", symbol: "₩" },
        { code: "KWD", name: "Kuwaiti Dinar", symbol: "د.ك" },
        { code: "KYD", name: "Cayman Islands Dollar", symbol: "$" },
        { code: "KZT", name: "Kazakhstani Tenge", symbol: "₸" },
        { code: "LAK", name: "Laotian Kip", symbol: "₭" },
        { code: "LBP", name: "Lebanese Pound", symbol: "ل.ل" },
        { code: "LKR", name: "Sri Lankan Rupee", symbol: "Rs" },
        { code: "LRD", name: "Liberian Dollar", symbol: "$" },
        { code: "LSL", name: "Lesotho Loti", symbol: "L" },
        { code: "LYD", name: "Libyan Dinar", symbol: "ل.د" },
        { code: "MAD", name: "Moroccan Dirham", symbol: "د.م." },
        { code: "MDL", name: "Moldovan Leu", symbol: "L" },
        { code: "MGA", name: "Malagasy Ariary", symbol: "Ar" },
        { code: "MKD", name: "Macedonian Denar", symbol: "ден" },
        { code: "MMK", name: "Myanmar Kyat", symbol: "K" },
        { code: "MNT", name: "Mongolian Tugrik", symbol: "₮" },
        { code: "MOP", name: "Macanese Pataca", symbol: "MOP$" },
        { code: "MRU", name: "Mauritanian Ouguiya", symbol: "UM" },
        { code: "MUR", name: "Mauritian Rupee", symbol: "₨" },
        { code: "MVR", name: "Maldivian Rufiyaa", symbol: "Rf" },
        { code: "MWK", name: "Malawian Kwacha", symbol: "MK" },
        { code: "MXN", name: "Mexican Peso", symbol: "$" },
        { code: "MYR", name: "Malaysian Ringgit", symbol: "RM" },
        { code: "MZN", name: "Mozambican Metical", symbol: "MT" },
        { code: "NAD", name: "Namibian Dollar", symbol: "$" },
        { code: "NGN", name: "Nigerian Naira", symbol: "₦" },
        { code: "NIO", name: "Nicaraguan Córdoba", symbol: "C$" },
        { code: "NOK", name: "Norwegian Krone", symbol: "kr" },
        { code: "NPR", name: "Nepalese Rupee", symbol: "₨" },
        { code: "NZD", name: "New Zealand Dollar", symbol: "$" },
        { code: "OMR", name: "Omani Rial", symbol: "ر.ع." },
        { code: "PAB", name: "Panamanian Balboa", symbol: "B/." },
        { code: "PEN", name: "Peruvian Sol", symbol: "S/." },
        { code: "PGK", name: "Papua New Guinean Kina", symbol: "K" },
        { code: "PHP", name: "Philippine Peso", symbol: "₱" },
        { code: "PKR", name: "Pakistani Rupee", symbol: "₨" },
        { code: "PLN", name: "Polish Zloty", symbol: "zł" },
        { code: "PYG", name: "Paraguayan Guarani", symbol: "₲" },
        { code: "QAR", name: "Qatari Riyal", symbol: "ر.ق" },
        { code: "RON", name: "Romanian Leu", symbol: "lei" },
        { code: "RSD", name: "Serbian Dinar", symbol: "дин." },
        { code: "RUB", name: "Russian Ruble", symbol: "₽" },
        { code: "RWF", name: "Rwandan Franc", symbol: "FRw" },
        { code: "SAR", name: "Saudi Riyal", symbol: "ر.س" },
        { code: "SBD", name: "Solomon Islands Dollar", symbol: "$" },
        { code: "SCR", name: "Seychellois Rupee", symbol: "₨" },
        { code: "SDG", name: "Sudanese Pound", symbol: "£" },
        { code: "SEK", name: "Swedish Krona", symbol: "kr" },
        { code: "SGD", name: "Singapore Dollar", symbol: "$" },
        { code: "SHP", name: "Saint Helena Pound", symbol: "£" },
        { code: "SLL", name: "Sierra Leonean Leone", symbol: "Le" },
        { code: "SOS", name: "Somali Shilling", symbol: "Sh" },
        { code: "SRD", name: "Surinamese Dollar", symbol: "$" },
        { code: "SSP", name: "South Sudanese Pound", symbol: "£" },
        { code: "STN", name: "São Tomé and Príncipe Dobra", symbol: "Db" },
        { code: "SYP", name: "Syrian Pound", symbol: "£" },
        { code: "SZL", name: "Swazi Lilangeni", symbol: "L" },
        { code: "THB", name: "Thai Baht", symbol: "฿" },
        { code: "TJS", name: "Tajikistani Somoni", symbol: "ЅМ" },
        { code: "TMT", name: "Turkmenistani Manat", symbol: "T" },
        { code: "TND", name: "Tunisian Dinar", symbol: "د.ت" },
        { code: "TOP", name: "Tongan Paʻanga", symbol: "T$" },
        { code: "TRY", name: "Turkish Lira", symbol: "₺" },
        { code: "TTD", name: "Trinidad and Tobago Dollar", symbol: "TT$" },
        { code: "TWD", name: "New Taiwan Dollar", symbol: "NT$" },
        { code: "TZS", name: "Tanzanian Shilling", symbol: "TSh" },
        { code: "UAH", name: "Ukrainian Hryvnia", symbol: "₴" },
        { code: "UGX", name: "Ugandan Shilling", symbol: "USh" },
        { code: "USD", name: "United States Dollar", symbol: "$" },
        { code: "UYU", name: "Uruguayan Peso", symbol: "$U" },
        { code: "UZS", name: "Uzbekistan Som", symbol: "so'm" },
        { code: "VES", name: "Venezuelan Bolívar", symbol: "Bs.S" },
        { code: "VND", name: "Vietnamese Dong", symbol: "₫" },
        { code: "VUV", name: "Vanuatu Vatu", symbol: "VT" },
        { code: "WST", name: "Samoan Tala", symbol: "WS$" },
        { code: "XAF", name: "CFA Franc BEAC", symbol: "FCFA" },
        { code: "XCD", name: "East Caribbean Dollar", symbol: "$" },
        { code: "XOF", name: "CFA Franc BCEAO", symbol: "CFA" },
        { code: "XPF", name: "CFP Franc", symbol: "₣" },
        { code: "YER", name: "Yemeni Rial", symbol: "﷼" },
        { code: "ZAR", name: "South African Rand", symbol: "R" },
        { code: "ZMW", name: "Zambian Kwacha", symbol: "ZK" },
        { code: "ZWL", name: "Zimbabwean Dollar", symbol: "Z$" }
    ];

    res.status(200).json({ success: true, currencies });
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

function getTravelClassName(classCode, airlineCode = null) {
    if (!classCode) return 'Unknown';
    const code = classCode.toUpperCase();

    // Airline-specific overrides
    const airlineOverrides = {
        'EK': { 'O': 'Business', 'E': 'Premium Economy', 'W': 'Premium Economy' }, // example: XYZ airline
        'AT': { 'P': 'Economy' },
        'UX': { 'O': 'Business' },
        'VN': { 'A': 'Economy'}// example: ABC airline
        // Add more airlines and their custom codes here

    };

    if (airlineCode && airlineOverrides[airlineCode]) {
        const airlineMapping = airlineOverrides[airlineCode];
        if (airlineMapping[code]) return airlineMapping[code];
    }

    // Default mapping
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
    
    //const flightSegmentRegexCompact = /^\s*(\d+)\s+([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    const flightSegmentRegexCompact = /^\s*(?:(\d+)\s+)?(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s*\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    //const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;
    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;
    const flightSegmentRegexSabre = /^\s*(?:(\d+)\s*\.?\s*)?([A-Z0-9]{2})\s+(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})([A-Z]{3})\s+(?:\S+\s+)?(\d{4})\s+([#\+\-]?\d{4})/;
    const flightSegmentRegexType3 = /^\s*(?:(\d+)\s*\.?\s*)?([A-Z0-9]{2})\s*(\d{1,4})\s*([A-Z])\s+([0-3]\d[A-Z]{3})\s+(?:\d\s+)?([A-Z]{3})([A-Z]{3})\s+(?:\S+\s+)?(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    const halts = /\bE\s*(\d{1,2})\b(?![A-Z])/i;
    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (let rawLine of lines) {
        if (!rawLine) continue;

        // Remove any leading "*" for codeshare/indicator flights
        let line = rawLine.replace(/^\s*\*/, '');

        let flightMatch = line.match(flightSegmentRegexCompact);
        //let segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator, depTerminal, arrTerminal;
        let segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator, depTerminal, arrTerminal, prefixOperatingCode;
        if (flightMatch) {
            [, segmentNumStr, prefixOperatingCode, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            depTerminal = null;
            arrTerminal = null;
        } else {
            flightMatch = line.match(flightSegmentRegexFlexible);
            if (flightMatch) {
                [, segmentNumStr, prefixOperatingCode, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, depTerminal, arrAirport, arrTerminal, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
            } else {
                flightMatch = line.match(flightSegmentRegexSabre);
                if (flightMatch) {
                    [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr] = flightMatch;
                    prefixOperatingCode = null;
                    depTerminal = null;
                    arrTerminal = null;
                    arrDateStrOrNextDayIndicator = null;
                    
                    if (arrTimeStr.startsWith('#') || arrTimeStr.startsWith('+')) {
                        arrDateStrOrNextDayIndicator = '+1';
                        arrTimeStr = arrTimeStr.substring(1);
                    } else if (arrTimeStr.startsWith('-')) {
                        arrDateStrOrNextDayIndicator = '-1';
                        arrTimeStr = arrTimeStr.substring(1);
                    }
                } else {
                    flightMatch = line.match(flightSegmentRegexType3);
                    if (flightMatch) {
                        [, segmentNumStr, airlineCode, flightNumRaw, travelClass, depDateStr, depAirport, arrAirport, depTimeStr, arrTimeStr, arrDateStrOrNextDayIndicator] = flightMatch;
                        prefixOperatingCode = null;
                        depTerminal = null;
                        arrTerminal = null;
                    }
                }
            }
        }

        const operatedByMatch = line.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(line);
        if (isPassengerLine) {
            const cleanedLine = line.replace(/^\s*\d+\.\s*/, '');
            const nameBlocks = cleanedLine.split(/\s+\d+\.\s*/);

            for (const nameBlock of nameBlocks) {
                if (!nameBlock.trim()) continue;

                // Match patterns like "BUCHANA/TALEAH JANE(CHD/11JUN23)" or "GASATURA KAMIKAZI/DEBORAH MRS"
                const match = nameBlock.trim().match(/^([A-Z' -]+)\/([A-Z' .-]+)(\([^)]*\))?/i);
                if (!match) continue;

                const lastName = match[1].trim();
                let givenNamesRaw = match[2].trim();
                let extraInfo = match[3] ? match[3].trim() : ''; // e.g. (CHD/11JUN23)

                    // Handle title at the end (MR, MRS, MISS, etc.)
                const titles = ['MR', 'MRS', 'MS', 'MSTR', 'MISS', 'CHD', 'INF'];
                const words = givenNamesRaw.split(/\s+/);
                const lastWord = words[words.length - 1].toUpperCase();
                let title = '';
                if (titles.includes(lastWord)) title = words.pop();
                const givenNames = words.join(' ');

                // Construct formatted passenger name
                let formattedName = `${lastName.toUpperCase()}/${givenNames.toUpperCase()}`;
                if (title) formattedName += ` ${title}`;
                if (extraInfo) formattedName += ` ${extraInfo}`; // add DOB part like (CHD/11JUN23)

                if (!passengers.includes(formattedName)) passengers.push(formattedName);
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
            const isTrainSegment = detailsParts.some(part => part.toUpperCase() === 'TRN' || part.toUpperCase() === 'TRAIN');
            const isBusSegment = !isTrainSegment && detailsParts.some(part => part.toUpperCase() === 'BUS' || part.toUpperCase() === 'BUSS');

            if (isTrainSegment) {
                aircraftCodeKey = 'TRAIN';
            } else if (isBusSegment) {
                aircraftCodeKey = 'BUS';
            } else {
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
            }
            // --- END OF THE FIX ---

            const validMealCharsRegex = /^[BLDSMFHCVKOPRWYNG]+$/i;
            let mealCode = null;

            for (const p of detailsParts) {
                // 1. SKIP VALIDATION:
                // If the part contains a number (e.g., "HK1", "738", "23KG"), it is NOT a meal code.
                if (/\d/.test(p)) continue;

                // If the part contains a slash (e.g., "WB/ABC123"), it is a PNR reference, NOT a meal.
                if (p.includes('/')) continue;

                // If the part is the specific "E" indicator (E-Ticket) often found in Galileo, skip it.
                if (p.toUpperCase() === 'E') continue;

                // If the part is the train marker, skip it from meal detection.
                if (p.toUpperCase() === 'TRN' || p.toUpperCase() === 'TRAIN') continue;

                // 2. CLEAN AND CHECK:
                const tok = p.replace(/[^A-Za-z]/g, '');
                
                // Only accept if it matches valid characters AND is not an empty string
                if (tok.length > 0 && validMealCharsRegex.test(tok)) { 
                    mealCode = tok; 
                    break; 
                }
            }

            const depAirportInfo = lookupLocationData(depAirport, isTrainSegment, isBusSegment);
            const arrAirportInfo = lookupLocationData(arrAirport, isTrainSegment, isBusSegment);

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
                if (arrDateStrOrNextDayIndicator.startsWith('+') || arrDateStrOrNextDayIndicator.startsWith('-')) {
                    // +1 or +n or -1 day logic
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator, 10);
                    const arrDate = departureMoment.clone().add(daysToAdd, 'days').format('DDMMMYYYY');
                    arrivalMoment = moment.tz(`${arrDate} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                } else {
                    // Explicit arrival date
                    const arrDateMoment = moment.utc(arrDateStrOrNextDayIndicator, "DDMMM");
                    let arrivalYear = departureMoment.year();
                    if (arrDateMoment.month() < departureMoment.month()) arrivalYear++;
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator}${arrivalYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                // No explicit date, check if arrival time < departure time
                arrivalMoment = moment.tz(`${depDateStr}${currentYear} ${arrTimeStr}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
            }

            // Ensure arrival is chronologically after departure. 
            // This fixes issues where timezone differences cause the local arrival time 
            // to mathematically fall before the local departure time (e.g., crossing datelines).
            if (arrivalMoment.isValid() && departureMoment.isValid()) {
                while (arrivalMoment.isBefore(departureMoment)) {
                    arrivalMoment.add(1, 'day');
                }
            }

            if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment && departureMoment.isValid()) {
                const transitDuration = moment.duration(departureMoment.diff(previousArrivalMoment));
                const transitMinutes = transitDuration.asMinutes();

                if (transitMinutes > 30) { // filter very short/long
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
                if (arrivalMoment.format("YYYY-MM-DD") !== departureMoment.format("YYYY-MM-DD")) {
                    arrivalDateString = arrivalMoment.format("DDMMM").toUpperCase();
                }
            }

            let initialOperatedBy = null;
            if (prefixOperatingCode) {
                const opName = airlineDatabase[prefixOperatingCode.toUpperCase()];
                initialOperatedBy = opName ? `${opName} (${prefixOperatingCode})` : prefixOperatingCode;
            }

            currentFlight = {
                segment: parseInt(segmentNumStr, 10) || flightIndex,
                airline: {
                    code: airlineCode,
                    name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})`
                },
                flightNumber: flightNumRaw,
                operatedBy: initialOperatedBy,
                travelClass: { code: travelClass || '', name: getTravelClassName(travelClass, airlineCode) },
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
                // Special handling for train segments and normal aircraft lookup.
                segmentType: isTrainSegment ? 'Train' : isBusSegment ? 'Bus' : 'Air',
                isTrainSegment,
                isBusSegment,
                aircraft: aircraftCodeKey === 'TRAIN'
                    ? 'Train'
                    : aircraftCodeKey === 'BUS'
                        ? 'Bus'
                        : (aircraftTypes[aircraftCodeKey] || aircraftCodeKey || ''),
                meal: getMealDescription(mealCode),
                notes: [],
                operatedBy: null,
                transitTime: precedingTransitTimeForThisSegment,
                transitDurationMinutes: transitDurationInMinutes,
                formattedNextDepartureTime: formattedNextDepartureTime
            };
        const haltsMatch = line.match(/\bE\s*(\d{1,2})\b(?![A-Z])/i);
if (haltsMatch) {
    currentFlight.halts = haltsMatch[1].trim();
    if (currentFlight.halts === '0'){
        currentFlight.halts = "DIRECT";
    }
} else {
    currentFlight.halts = "0"; // default if not found
}
        previousArrivalMoment = arrivalMoment.clone();
        } else if (currentFlight && operatedByMatch) {
            const textOpBy = operatedByMatch[1].trim();
            // If we already have a prefix (like IndiGo), we can append or prioritize the text description
            currentFlight.operatedBy = currentFlight.operatedBy
                ? `${currentFlight.operatedBy} / ${textOpBy}`
                : textOpBy;
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
        flights[0].direction = 'OUTBOUND';

        const STOPOVER_THRESHOLD_MINUTES = 1440; // 24 hours

        // Define both possible time formats
        const format12h = "DD MMM YYYY hh:mm A";
        const format24h = "DD MMM YYYY HH:mm";

        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currentFlight = flights[i];

            const prevArrAirportInfo = lookupLocationData(prevFlight.arrival.airport, prevFlight.isTrainSegment);
            if (!moment.tz.zone(prevArrAirportInfo.timezone)) prevArrAirportInfo.timezone = 'UTC';

            const currDepAirportInfo = lookupLocationData(currentFlight.departure.airport, currentFlight.isTrainSegment);
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
            
                if ( stopoverMinutes > 1440 ) {
                    currentFlight.direction = 'INBOUND';
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