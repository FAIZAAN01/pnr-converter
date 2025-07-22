function parseGalileoEnhanced(pnrText, options) {
    options = options || {};
    const rawText = (pnrText || '').toUpperCase();
    const flights = [];
    const passengers = [];
    const lines = rawText.split('\n').map(line => line.trim());
    let currentFlight = null;
    let flightIndex = 0;
    let previousArrivalMoment = null;

    const flightSegmentRegex = /^\s*(?:(\d+)\s+)?(?:([A-Z0-9]{2}):)?([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)\s+([A-Z])\s+([0-3]\d[A-Z]{3})\s+\d*\*?\s*([A-Z]{6})\s+\S+\s+(\d{4})\s+(\d{4})(?:\s+([0-3]\d[A-Z]{3}|\+\d))?\s+E?\s*\d*\s*([A-Z0-9]{2,4})\s*([A-Z]+)?$/ix;

    const operatedByRegex = /OPERATED BY\s+(.+)/i;
    const passengerLineIdentifierRegex = /^\s*\d+\.\s*[A-Z/]/;

    for (const originalLine of lines) {
        if (!originalLine) continue;

        const operatedByMatch = originalLine.match(operatedByRegex);
        const isPassengerLine = passengerLineIdentifierRegex.test(originalLine);

        if (isPassengerLine) {
            const cleanedLine = originalLine.replace(/^\s*\d+\.\s*/, '');
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
        } else {
            const m = originalLine.match(flightSegmentRegex);
            if (m) {
                if (currentFlight) flights.push(currentFlight);
                flightIndex++;

                const segmentNumStr = m[1];
                const operatedCarrier = m[2];
                const airlineCode = m[3];
                const flightNumRaw = m[4];
                const travelClass = m[5];
                const depDateStr = m[6];
                const combinedAirports = m[7];
                const depTimeStr = m[8];
                const arrTimeStr = m[9];
                const arrDateStrOrNextDayIndicator = m[10];
                const aircraftType = m[11];
                const mealCodeRaw = m[12];

                const depAirport = combinedAirports.slice(0, 3);
                const arrAirport = combinedAirports.slice(3);

                const depAirportInfo = airportDatabase[depAirport] || { city: `Unknown`, name: `Airport (${depAirport})`, timezone: 'UTC' };
                const arrAirportInfo = airportDatabase[arrAirport] || { city: `Unknown`, name: `Airport (${arrAirport})`, timezone: 'UTC' };
                if (!moment.tz.zone(depAirportInfo.timezone)) depAirportInfo.timezone = 'UTC';
                if (!moment.tz.zone(arrAirportInfo.timezone)) arrAirportInfo.timezone = 'UTC';

                const departureMoment = moment.tz(`${depDateStr} ${depTimeStr}`, 'DDMMM HHmm', true, depAirportInfo.timezone);

                let arrivalMoment;
                if (arrDateStrOrNextDayIndicator) {
                    if (arrDateStrOrNextDayIndicator.startsWith('+')) {
                        const daysToAdd = parseInt(arrDateStrOrNextDayIndicator.substring(1), 10);
                        arrivalMoment = departureMoment.clone().add(daysToAdd, 'day').hour(arrTimeStr.slice(0, 2)).minute(arrTimeStr.slice(2, 4));
                    } else {
                        arrivalMoment = moment.tz(`${arrDateStrOrNextDayIndicator} ${arrTimeStr}`, 'DDMMM HHmm', true, arrAirportInfo.timezone);
                    }
                } else {
                    arrivalMoment = moment.tz(`${depDateStr} ${arrTimeStr}`, 'DDMMM HHmm', true, arrAirportInfo.timezone);
                    if (
                        departureMoment.isValid() &&
                        arrivalMoment.isValid() &&
                        arrivalMoment.isSameOrBefore(departureMoment)
                    ) {
                        arrivalMoment.add(1, 'day');
                    }
                }

                let precedingTransitTimeForThisSegment = null;
                let transitDurationInMinutes = null;
                let formattedNextDepartureTime = null;

                if (previousArrivalMoment && previousArrivalMoment.isValid() && departureMoment && departureMoment.isValid()) {
                    const transitDuration = moment.duration(departureMoment.diff(previousArrivalMoment));
                    const totalMinutes = transitDuration.asMinutes();
                    if (totalMinutes > 30 && totalMinutes < 1440) {
                        const hours = Math.floor(transitDuration.asHours());
                        const minutes = transitDuration.minutes();
                        precedingTransitTimeForThisSegment = `${hours < 10 ? '0' : ''}${hours}h ${minutes < 10 ? '0' : ''}${minutes}m`;
                        transitDurationInMinutes = Math.round(totalMinutes);
                        formattedNextDepartureTime = formatMomentTime(departureMoment, options.segmentTimeFormat === '24h');
                    }
                }

                const mealDescription = getMealDescription(mealCodeRaw);

                let arrivalDateString = null;
                if (departureMoment.isValid() && arrivalMoment && arrivalMoment.isValid() && !arrivalMoment.isSame(departureMoment, 'day')) {
                    arrivalDateString = arrivalMoment.format('DD MMM');
                }

                currentFlight = {
                    segment: parseInt(segmentNumStr, 10) || flightIndex,
                    operatedCarrier: operatedCarrier || null,
                    airline: { code: airlineCode, name: airlineDatabase[airlineCode] || `Unknown Airline (${airlineCode})` },
                    flightNumber: flightNumRaw,
                    travelClass: { code: travelClass || '', name: getTravelClassName(travelClass) },
                    date: departureMoment.isValid() ? departureMoment.format('dddd, DD MMM YYYY') : '',
                    departure: {
                        airport: depAirport,
                        city: depAirportInfo.city,
                        name: depAirportInfo.name,
                        time: formatMomentTime(departureMoment, options.segmentTimeFormat === '24h'),
                    },
                    arrival: {
                        airport: arrAirport,
                        city: arrAirportInfo.city,
                        name: arrAirportInfo.name,
                        time: arrivalMoment ? formatMomentTime(arrivalMoment, options.segmentTimeFormat === '24h') : '',
                        dateString: arrivalDateString,
                    },
                    duration: calculateAndFormatDuration(departureMoment, arrivalMoment),
                    equipment: aircraftType,
                    meal: mealDescription,
                    notes: [],
                    transitTime: precedingTransitTimeForThisSegment,
                    transitDurationMinutes: transitDurationInMinutes,
                    formattedNextDepartureTime: formattedNextDepartureTime,
                };

                previousArrivalMoment = arrivalMoment ? arrivalMoment.clone() : previousArrivalMoment;
            } else if (currentFlight && operatedByMatch) {
                currentFlight.operatedBy = operatedByMatch[1].trim();
            } else if (currentFlight && originalLine.trim().length > 0) {
                currentFlight.notes.push(originalLine.trim());
            }
        }
    }

    if (currentFlight) flights.push(currentFlight);

    return { flights, passengers };
}
