function parseGalileoEnhanced(pnrText, options) {
    const flights = [];
    const passengers = [];
    let pnrCode = null; // Variable to store the PNR code
    const lines = pnrText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    let previousArrivalMoment = null;

    let currentYear = null;
    let previousDepartureMonthIndex = -1;

    const use24hSegment = options.segmentTimeFormat === '24h';
    const use24hTransit = options.transitTimeFormat === '24h';

    // Regex to find the PNR code (Record Locator)
    const pnrCodeRegex = /^RP\/[A-Z0-9]+\/[A-Z0-9]+\s+[A-Z0-9\s]+\s+([A-Z0-9]+)$/;
    const flightSegmentRegexCompact = /^\s*(\d+)\s+([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\S*\s*([A-Z]{3})([A-Z]{3})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}))?/;
    const flightSegmentRegexFlexible = /^\s*(?:(\d+)\s+)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+([A-Z]{3})\s*([\dA-Z]*)?\s+([A-Z]{3})\s*([\dA-Z]*)?\s+(\d{4})\s+(\d{4})(?:\s*([0-3]\d[A-Z]{3}|\+\d))?/;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (let rawLine of lines) {
        if (!rawLine) continue;

        let line = rawLine.replace(/^\s*\*/, '');

        const pnrMatch = line.match(pnrCodeRegex);
        if (pnrMatch && pnrMatch[1]) {
            pnrCode = pnrMatch[1];
        }

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
            // *** THE FLWN FILTER HAS BEEN REMOVED FROM HERE ***

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
            // For FLWN or past segments, there's no time, so we set it to midnight.
            const depTime = depTimeStr || '0000';
            const arrTime = arrTimeStr || '0000';

            const departureMoment = moment.tz(fullDepDateStr + " " + depTime, "DDMMMYYYY HHmm", true, depAirportInfo.timezone);

            let arrivalMoment;
            if (arrDateStrOrNextDayIndicator) {
                if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                    const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                    arrivalMoment = departureMoment.clone().add(daysToAdd, 'days')
                        .set({
                            hour: parseInt(arrTime.substring(0, 2)),
                            minute: parseInt(arrTime.substring(2, 4))
                        });
                } else {
                    const arrDateMoment = moment.utc(arrDateStrOrNextDayIndicator, "DDMMM");
                    let arrivalYear = departureMoment.year();
                    if (arrDateMoment.month() < departureMoment.month()) arrivalYear++;
                    arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator}${arrivalYear} ${arrTime}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
                }
            } else {
                arrivalMoment = moment.tz(`${depDateStr}${currentYear} ${arrTime}`, "DDMMMYYYY HHmm", true, arrAirportInfo.timezone);
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
                    airport: depAirport, city: depAirportInfo.city, name: depAirportInfo.name,
                    time: depTimeStr ? formatMomentTime(departureMoment, use24hSegment) : 'N/A',
                    terminal: normalizeTerminal(depTerminal)
                },
                arrival: {
                    airport: arrAirport,
                    city: arrAirportInfo.city,
                    name: arrAirportInfo.name,
                    time: arrTimeStr ? formatMomentTime(arrivalMoment, use24hSegment) : 'N/A',
                    dateString: arrivalDateString,
                    terminal: normalizeTerminal(arrTerminal)
                },
                duration: (depTimeStr && arrTimeStr) ? calculateAndFormatDuration(departureMoment, arrivalMoment) : 'N/A',
                aircraft: aircraftTypes[aircraftCodeKey] || aircraftCodeKey || '',
                meal: getMealDescription(mealCode),
                notes: line.includes('FLWN') ? ['Status: FLOWN'] : [],
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

    if (flights.length > 1) { // Only calculate direction if there's more than one flight
        for (const flight of flights) {
            flight.direction = null;
        }
        flights[0].direction = '';

        const STOPOVER_THRESHOLD_MINUTES = 1440;
        const format12h = "DD MMM YYYY hh:mm A";
        const format24h = "DD MMM YYYY HH:mm";

        for (let i = 1; i < flights.length; i++) {
            const prevFlight = flights[i - 1];
            const currentFlight = flights[i];

            // Skip if time is not available
            if (prevFlight.arrival.time === 'N/A' || currentFlight.departure.time === 'N/A') continue;

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
                    currentFlight.direction = isRoundTrip ? '' : '';
                }
            } else {
                console.error("Moment.js parsing failed! Check formats.");
                console.error(`- Previous Arrival: '${prevFlight.arrival.time}' with format '${prevTimeFormat}'`);
                console.error(`- Current Departure: '${currentFlight.departure.time}' with format '${currTimeFormat}'`);
            }
        }
    }

    return { flights, passengers, pnrCode };
}