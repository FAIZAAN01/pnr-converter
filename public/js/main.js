const OPTIONS_STORAGE_KEY = 'pnrConverterOptions';
const CUSTOM_LOGO_KEY = 'pnrConverterCustomLogo';
const CUSTOM_TEXT_KEY = 'pnrConverterCustomText';
const HISTORY_STORAGE_KEY = 'pnrConversionHistory';

let lastPnrResult = null;

// --- UTILITY FUNCTIONS ---
function showPopup(message, duration = 3000) {
    const container = document.getElementById('popupContainer');
    if (!container) return;
    const popup = document.createElement('div');
    popup.className = 'popup-notification';
    popup.textContent = message;
    container.appendChild(popup);
    setTimeout(() => popup.classList.add('show'), 10);
    setTimeout(() => {
        popup.classList.remove('show');
        popup.addEventListener('transitionend', () => popup.remove());
    }, duration);
}

function debounce(func, wait) {
    let timeout;
    return function (...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => func.apply(this, args), wait);
    };
}

// --- START: NEW FUNCTION TO RESET FARE & BAGGAGE INPUTS ---

function resetFareAndBaggageInputs() {
    // Reset all fare-related text inputs to be empty
    document.getElementById('adultFareInput').value = '';
    document.getElementById('childFareInput').value = '';
    document.getElementById('infantFareInput').value = '';
    document.getElementById('taxInput').value = '';
    document.getElementById('feeInput').value = '';

    // Reset passenger counts to their default values
    document.getElementById('adultCountInput').value = '1';
    document.getElementById('childCountInput').value = '0';
    document.getElementById('infantCountInput').value = '0';

    // Reset currency to the default (USD)
    document.getElementById('currencySelect').value = 'USD';

    // Reset baggage selection to "Particular"
    document.getElementById('baggageParticular').checked = true;

    // Also trigger a 'change' event on the radio button.
    // This is important to make sure any associated UI logic (like hiding/showing other inputs) runs.
    document.getElementById('baggageParticular').dispatchEvent(new Event('change'));

    // If a result is currently displayed, update it to remove the now-cleared fare summary
    if (lastPnrResult) {
        liveUpdateDisplay();
    }
}
// --- END: NEW FUNCTION ---

function reverseString(str) {
    if (!str) return '';
    return str.split('').reverse().join('');
}

async function generateItineraryCanvas(element) {
    if (!element) throw new Error("Element for canvas generation not found.");
    const options = { scale: 0.5, backgroundColor: '#ffffff', useCORS: true };
    return await html2canvas(element, options);
}

// --- ADDED: Helper function to get the unit from the new toggle ---
function getSelectedUnit() {
    const unitToggle = document.getElementById('unit-selector-checkbox');
    // If the toggle checkbox exists and is checked, return 'pcs'. Otherwise, default to 'kgs'.
    return unitToggle?.checked ? 'Pcs' : 'Kgs';
}


// --- UI HELPER FUNCTIONS ---
function toggleFareInputsVisibility() {
    const showTaxes = document.getElementById('showTaxes').checked;
    const showFees = document.getElementById('showFees').checked;
    document.getElementById('taxInputContainer').classList.toggle('hidden', !showTaxes);
    document.getElementById('feeInputContainer').classList.toggle('hidden', !showFees);
}

function toggleTransitSymbolInputVisibility() {
    const showTransit = document.getElementById('showTransit').checked;
    document.getElementById('transitSymbolContainer').classList.toggle('hidden', !showTransit);
}

function toggleCustomBrandingSection() {
    document.getElementById('customBrandingSection').classList.toggle(
        'hidden', !document.getElementById('showItineraryLogo').checked
    );
}

function updateEditableState() {
    const isEditable = document.getElementById('editableToggle').checked;
    document.getElementById('output').contentEditable = isEditable;
}

// --- OPTIONS & BRANDING MANAGEMENT ---
function saveOptions() {
    try {
        const optionsToSave = {
            autoConvertOnPaste: document.getElementById('autoConvertToggle').checked,
            isEditable: document.getElementById('editableToggle').checked,
            segmentTimeFormat: document.querySelector('input[name="segmentTimeFormat"]:checked').value,
            transitTimeFormat: document.querySelector('input[name="transitTimeFormat"]:checked').value,
            showItineraryLogo: document.getElementById('showItineraryLogo').checked,
            showAirline: document.getElementById('showAirline').checked,
            showAircraft: document.getElementById('showAircraft').checked,
            showOperatedBy: document.getElementById('showOperatedBy').checked,
            showClass: document.getElementById('showClass').checked,
            showMeal: document.getElementById('showMeal').checked,
            showNotes: document.getElementById('showNotes').checked,
            showTransit: document.getElementById('showTransit').checked,
            transitSymbol: document.getElementById('transitSymbolInput').value,
            currency: document.getElementById('currencySelect').value,
            showTaxes: document.getElementById('showTaxes').checked,
            showFees: document.getElementById('showFees').checked,
            // --- ADDED: Save the state of the new toggle switch ---
            baggageUnit: getSelectedUnit(),
        };
        localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(optionsToSave));
    } catch (e) { console.error("Failed to save options:", e); }
}

function loadOptions() {
    try {
        const savedOptions = JSON.parse(localStorage.getItem(OPTIONS_STORAGE_KEY) || '{}');

        document.getElementById('autoConvertToggle').checked = savedOptions.autoConvertOnPaste ?? false;
        document.getElementById('editableToggle').checked = savedOptions.isEditable ?? false;

        const savedSegmentFormat = savedOptions.segmentTimeFormat || '24h';
        const segmentRadio = document.querySelector(`input[name="segmentTimeFormat"][value="${savedSegmentFormat}"]`);
        if (segmentRadio) segmentRadio.checked = true;

        const savedTransitFormat = savedOptions.transitTimeFormat || '24h';
        const transitRadio = document.querySelector(`input[name="transitTimeFormat"][value="${savedTransitFormat}"]`);
        if (transitRadio) transitRadio.checked = true;

        const checkboxIds = [
            'showItineraryLogo', 'showAirline', 'showAircraft', 'showOperatedBy',
            'showClass', 'showMeal', 'showNotes', 'showTransit', 'showTaxes', 'showFees'
        ];
        const defaultValues = {
            showItineraryLogo: true, showAirline: true, showAircraft: true, showOperatedBy: true,
            showTransit: true, showTaxes: true, showFees: true
        };
        checkboxIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) el.checked = savedOptions[id] ?? (defaultValues[id] || false);
        });

        if (savedOptions.currency) {
            document.getElementById('currencySelect').value = savedOptions.currency;
        }

        // --- ADDED: Load the saved state for the new toggle switch ---
        if (savedOptions.baggageUnit) {
            document.getElementById('unit-selector-checkbox').checked = savedOptions.baggageUnit === 'pcs';
        }

        document.getElementById('transitSymbolInput').value = savedOptions.transitSymbol ?? ':::::::';

        const customLogoData = localStorage.getItem(CUSTOM_LOGO_KEY);
        const customTextData = localStorage.getItem(CUSTOM_TEXT_KEY);
        const logoPreview = document.getElementById('customLogoPreview');
        if (customLogoData && logoPreview) {
            logoPreview.src = customLogoData;
            logoPreview.style.display = 'block';
        }
        if (customTextData) {
            document.getElementById('customTextInput').value = customTextData;
        }

        updateEditableState();
        toggleCustomBrandingSection();
        toggleFareInputsVisibility();
        toggleTransitSymbolInputVisibility();

    } catch (e) { console.error("Failed to load options:", e); }
}

// --- CORE APP LOGIC ---
async function handleConvertClick() {

    const pnrText = document.getElementById('pnrInput').value;
    if (!pnrText.trim() && !lastPnrResult) {
        showPopup("Please enter PNR text to convert.");
        return;
    }

    const output = document.getElementById('output');
    const loadingSpinner = document.getElementById('loadingSpinner');

    loadingSpinner.style.display = 'block';
    if (pnrText.trim()) {
        output.innerHTML = '';
    }

    const options = {
        segmentTimeFormat: document.querySelector('input[name="segmentTimeFormat"]:checked').value,
        transitTimeFormat: document.querySelector('input[name="transitTimeFormat"]:checked').value,
    };

    try {
        const currentPnr = pnrText.trim() ? pnrText : (lastPnrResult?.pnrText || '');
        if (!currentPnr) {
            throw new Error("No PNR data to process.");
        }

        const response = await fetch('/api/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pnrText: currentPnr, options: options })
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(data.error || `Server error: ${response.status}`);
        }

        lastPnrResult = { ...data.result, pnrText: currentPnr };

        resetFareAndBaggageInputs();

        if (pnrText.trim()) {
            document.getElementById('pnrInput').value = '';
        }

        liveUpdateDisplay(true);

        if (data.success && data.result?.flights?.length > 0 && pnrText.trim()) {
            historyManager.add({ ...data, pnrText: currentPnr });
        }

    } catch (error) {
        console.error('Conversion error:', error);
        output.innerHTML = `<div class="error">Failed to process request: ${error.message}</div>`;
        lastPnrResult = null;
        liveUpdateDisplay(false);
    } finally {
        loadingSpinner.style.display = 'none';
    }
}

function liveUpdateDisplay(pnrProcessingAttempted = false) {
    if (!lastPnrResult) {
        if (pnrProcessingAttempted) {
            document.getElementById('output').innerHTML = '<div class="info">No flight segments found or PNR format not recognized.</div>';
        }
        document.getElementById('screenshotBtn').style.display = 'none';
        document.getElementById('copyTextBtn').style.display = 'none';
        return;
    }

    const displayPnrOptions = {
        showItineraryLogo: document.getElementById('showItineraryLogo').checked,
        showAirline: document.getElementById('showAirline').checked,
        showAircraft: document.getElementById('showAircraft').checked,
        showOperatedBy: document.getElementById('showOperatedBy').checked,
        showClass: document.getElementById('showClass').checked,
        showMeal: document.getElementById('showMeal').checked,
        showNotes: document.getElementById('showNotes').checked,
        showTransit: document.getElementById('showTransit').checked,
        transitSymbol: document.getElementById('transitSymbolInput').value || ':::::::',
    };

    const fareDetails = {
        adultCount: document.getElementById('adultCountInput').value,
        adultFare: document.getElementById('adultFareInput').value,
        childCount: document.getElementById('childCountInput').value,
        childFare: document.getElementById('childFareInput').value,
        infantCount: document.getElementById('infantCountInput').value,
        infantFare: document.getElementById('infantFareInput').value,
        tax: document.getElementById('taxInput').value,
        fee: document.getElementById('feeInput').value,
        currency: document.getElementById('currencySelect').value,
        showTaxes: document.getElementById('showTaxes').checked,
        showFees: document.getElementById('showFees').checked,
    };

    const baggageOption = document.querySelector('input[name="baggageOption"]:checked').value;
    const baggageDetails = {
        option: baggageOption,
        amount: (baggageOption === 'particular') ? document.getElementById('baggageAmountInput').value : '',
        unit: (baggageOption === 'particular') ? getSelectedUnit() : ''
    };

    const checkboxOutputs = {
        showVisaInfo: document.getElementById('showVisaInfo').checked,
        showHealthDocs: document.getElementById('showHealthDocs').checked,
        showTravelInsurance: document.getElementById('showTravelInsurance').checked,
        showCovidNotice: document.getElementById('showCovidNotice').checked,
        dontShowTravelInsurance: document.getElementById('dontShowTravelInsurance').checked,
    };

    displayResults(lastPnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted);
}

// --- REMOVED THE SEPARATE, UNUSED TOGGLE SWITCH CODE THAT WAS HERE ---

// --- MODIFIED FUNCTION ---
function displayResults(pnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted) {
    const output = document.getElementById('output');
    const screenshotBtn = document.getElementById('screenshotBtn');
    const copyTextBtn = document.getElementById('copyTextBtn');
    output.innerHTML = '';

    const { flights = [], passengers = [], recordLocator = '' } = pnrResult || {};

    if (flights.length > 0) {
        screenshotBtn.style.display = 'inline-block';
        copyTextBtn.style.display = 'inline-block';
    } else {
        screenshotBtn.style.display = 'none';
        copyTextBtn.style.display = 'none';
    }

    const outputContainer = document.createElement('div');
    outputContainer.className = 'output-container';

    if (flights.length > 0 && displayPnrOptions.showItineraryLogo) {
        const logoContainer = document.createElement('div');
        logoContainer.className = 'itinerary-main-logo-container';
        const logoImg = document.createElement('img');
        logoImg.className = 'itinerary-main-logo';
        logoImg.src = localStorage.getItem(CUSTOM_LOGO_KEY) || '/simbavoyages.png';
        logoContainer.appendChild(logoImg);
        const logoText = document.createElement('div');
        logoText.className = 'itinerary-logo-text';
        logoText.innerHTML = (localStorage.getItem(CUSTOM_TEXT_KEY) || "KN2 Ave 26, Nyarugenge Dist, Muhima<BR>Kigali Rwanda").replace(/\n/g, '<br>');
        logoContainer.appendChild(logoText);
        outputContainer.appendChild(logoContainer);
    }

    if (passengers.length > 0) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'itinerary-header';

        let headerHTML = `<h4 style="margin-top: 0;">Itinerary for:</h4><p>${passengers.join('<br>')}</p>`;

        if (recordLocator) {
            headerHTML += `<h4 style="margin-top: 10px;">Booking Ref:</h4><p>${recordLocator}</p>`;
        }

        if (passengers.length > 1) {
            headerHTML += `<p style="margin-top: 8px; font-style: italic;">Total Passengers: ${passengers.length}</p>`;
        }

        headerDiv.innerHTML = headerHTML;
        outputContainer.appendChild(headerDiv);
    }


    if (flights.length > 0) {
        const itineraryBlock = document.createElement('div');
        itineraryBlock.className = 'itinerary-block';

        flights.forEach((flight, i) => {

            let currentHeadingDisplayed = null;

            if (flight.direction && flight.direction.toUpperCase() !== currentHeadingDisplayed) {

                const iconSrc = flight.direction.toUpperCase() === 'OUTBOUND'
                    ? '/icons/takeoff.png'
                    : '/icons/landing.png';

                const headingDiv = document.createElement('div');
                headingDiv.className = 'itinerary-leg-header';

                headingDiv.innerHTML = `
                    <span>${flight.direction.toUpperCase()}</span>
                    <img src="${iconSrc}" alt="${flight.direction}" class="leg-header-icon">
                `;

                itineraryBlock.appendChild(headingDiv);

                currentHeadingDisplayed = flight.direction.toUpperCase();
            }

            if (displayPnrOptions.showTransit && i > 0 && flight.transitTime && flight.transitDurationMinutes) {
                const transitDiv = document.createElement('div');
                const minutes = flight.transitDurationMinutes;
                const rawSymbol = displayPnrOptions.transitSymbol || ':::::::';

                const startSeparator = rawSymbol.replace(/ /g, ' ');
                const endSeparator = reverseString(rawSymbol).replace(/ /g, ' ');

                const transitLocationInfo = `at ${flights[i - 1].arrival?.city || ''} (${flights[i - 1].arrival?.airport || ''})`;

                let transitLabel, transitClassName;
                if (minutes <= 120) {
                    transitLabel = `Short Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-short';
                } else if (minutes > 300) {
                    transitLabel = `Long Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-long';
                } else {
                    transitLabel = `Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-minimum'
                }

                transitDiv.className = `transit-item ${transitClassName}`;
                transitDiv.innerHTML = `${startSeparator} ${transitLabel.trim()} ${endSeparator}`;
                itineraryBlock.appendChild(transitDiv);
            }

            const flightItem = document.createElement('div');
            flightItem.className = 'flight-item';

            let detailsHtml = '';
            let baggageText = '';
            if (baggageDetails && baggageDetails.option !== 'none' && baggageDetails.amount) {
                const baggageInfo = `${baggageDetails.amount}\u00A0${baggageDetails.unit}`;
                if (baggageDetails.option === 'particular') {
                    baggageText = baggageInfo;
                }
            }

            const depTerminalDisplay = flight.departure.terminal ? ` (T${flight.departure.terminal})` : '';
            const arrTerminalDisplay = flight.arrival.terminal ? ` (T${flight.arrival.terminal})` : '';
            const arrivalDateDisplay = flight.arrival.dateString ? ` on ${flight.arrival.dateString}` : '';

            const departureString = `${flight.departure.airport}${depTerminalDisplay} - ${flight.departure.city} (${flight.departure.country}), ${flight.departure.name} at ${flight.departure.time}`;
            const arrivalString = `${flight.arrival.airport}${arrTerminalDisplay} - ${flight.arrival.city} (${flight.arrival.country}), ${flight.arrival.name} at ${flight.arrival.time}${arrivalDateDisplay}`;

            const detailRows = [
                { label: 'Departing ', value: departureString },
                { label: 'Arriving \u00A0\u00A0\u00A0', value: arrivalString },
                { label: 'Baggage \u00A0\u00A0', value: baggageText || null },
                { label: 'Meal \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0', value: (displayPnrOptions.showMeal && flight.meal) ? getMealDescription(flight.meal) : null },
                { label: 'Operated by', value: (displayPnrOptions.showOperatedBy && flight.operatedBy) ? flight.operatedBy : null },
                { label: 'Notes \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0', value: (displayPnrOptions.showNotes && flight.notes?.length) ? flight.notes.join('; ') : null, isNote: true }
            ];

            detailRows.forEach(({ label, value, isNote }) => {
                if (value) {
                    detailsHtml += `<div class="flight-detail ${isNote ? 'notes-detail' : ''}"><strong>${label}:</strong> <span>${value}</span></div>`;
                }
            });

            const headerText = [flight.date, displayPnrOptions.showAirline ? (flight.airline.name || 'Unknown Airline') : '', flight.flightNumber, flight.duration, displayPnrOptions.showAircraft && flight.aircraft ? flight.aircraft : '', displayPnrOptions.showClass && flight.travelClass.name ? flight.travelClass.name : ''].filter(Boolean).join(' - ');

            flightItem.innerHTML = `<div class="flight-content">${displayPnrOptions.showAirline ? `<img src="/logos/${(flight.airline.code || 'xx').toLowerCase()}.png" class="airline-logo" alt="${flight.airline.name} logo" onerror="this.onerror=null; this.src='/logos/default-airline.svg';">` : ''}<div><div class="flight-header">${headerText}</div>${detailsHtml}</div></div>`;
            itineraryBlock.appendChild(flightItem);
        });

        // Display checkbox outputs
        const notesContainer = document.createElement('div');
        notesContainer.className = 'itinerary-notes';
        let notesHtml = '';
        if (checkboxOutputs.showCovidNotice) {
            notesHtml += `<p> <strong>&#9830</strong> Date Change Allowed.</p>`;
        }
        if (checkboxOutputs.showTravelInsurance) {
            notesHtml += `<p> <strong>&#9830</strong> Before Departure Changes Are Allowed.</p>`;
        }
        if (checkboxOutputs.dontShowTravelInsurance) {
            notesHtml += `<p> <strong>&#9830</strong> After Departure Non Refundable.</p>`;
        }
        if (checkboxOutputs.showVisaInfo) {
            notesHtml += `<p> <strong>&#9830</strong> Refundable With Aplicable Penalties.</p>`;
        }
        if (checkboxOutputs.showHealthDocs) {
            notesHtml += `<p> <strong>&#9830</strong> Non Refundable.</p>`;
        }

        const { adultCount, adultFare, childCount, childFare, infantCount, infantFare, tax, fee, currency, showTaxes, showFees } = fareDetails || {};
        const adultCountNum = parseInt(adultCount) || 0;
        const childCountNum = parseInt(childCount) || 0;
        const infantCountNum = parseInt(infantCount) || 0;
        const totalPax = adultCountNum + childCountNum + infantCountNum;

        if (totalPax > 0) {
            const adultFareNum = parseFloat(adultFare) || 0;
            const childFareNum = parseFloat(childFare) || 0;
            const infantFareNum = parseFloat(infantFare) || 0;
            const taxNum = parseFloat(tax) || 0;
            const feeNum = parseFloat(fee) || 0;
            const currencySymbol = currency || 'USD';

            const adultBaseTotal = adultCountNum * adultFareNum;
            const childBaseTotal = childCountNum * childFareNum;
            const infantBaseTotal = infantCountNum * infantFareNum;

            const totalTaxes = showTaxes ? totalPax * taxNum : 0;
            const totalFees = showFees ? totalPax * feeNum : 0;

            const grandTotal = adultBaseTotal + childBaseTotal + infantBaseTotal + totalTaxes + totalFees;

            if (grandTotal > 0) {
                let fareLines = [];
                if (adultBaseTotal > 0) fareLines.push(`Adult Fare (${adultCountNum} x ${adultFareNum.toFixed(2)}): ${adultBaseTotal.toFixed(2)}`);
                if (childBaseTotal > 0) fareLines.push(`Child Fare (${childCountNum} x ${childFareNum.toFixed(2)}): ${childBaseTotal.toFixed(2)}`);
                if (infantBaseTotal > 0) fareLines.push(`Infant Fare (${infantCountNum} x ${infantFareNum.toFixed(2)}): ${infantBaseTotal.toFixed(2)}`);
                if (showTaxes && totalTaxes > 0) fareLines.push(`Tax (${totalPax} x ${taxNum.toFixed(2)}): ${totalTaxes.toFixed(2)}`);
                if (showFees && totalFees > 0) fareLines.push(`Fees (${totalPax} x ${feeNum.toFixed(2)}): ${totalFees.toFixed(2)}`);
                fareLines.push(`<strong>Total (${currencySymbol}): ${grandTotal.toFixed(2)}</strong>`);

                const fareDiv = document.createElement('div');
                fareDiv.className = 'fare-summary';
                fareDiv.innerHTML = fareLines.join('<br>');
                itineraryBlock.appendChild(fareDiv);
            }
        }
        if (notesHtml) {
            notesContainer.innerHTML = `<hr><strong id="notes-header">Ticket Conditions:</strong>\n${notesHtml}`;
            itineraryBlock.appendChild(notesContainer);
        }
        outputContainer.appendChild(itineraryBlock);
    }
    else if (pnrProcessingAttempted) {
        outputContainer.innerHTML = '<div class="info">No flight segments found or PNR format not recognized.</div>';
    }

    if (outputContainer.hasChildNodes()) {
        output.appendChild(outputContainer);
    } else if (!pnrProcessingAttempted) {
        output.innerHTML = '<div class="info">Enter PNR data and click Convert to begin.</div>';
    }
}

function getMealDescription(mealCode) {
    // ... (This function remains unchanged)
    const mealMap = {
        B: 'BREAKFAST', K: 'CONTINENTAL BREAKFAST', L: 'LUNCH', D: 'DINNER', S: 'SNACK OR BRUNCH', O: 'COLD MEAL', H: 'HOT MEAL', M: 'MEAL (NON-SPECIFIC)', R: 'REFRESHMENT', C: 'ALCOHOLIC BEVERAGES COMPLIMENTARY', F: 'FOOD FOR PURCHASE', P: 'ALCOHOLIC BEVERAGES FOR PURCHASE', Y: 'DUTY FREE SALES AVAILABLE', N: 'NO MEAL SERVICE', V: 'REFRESHMENTS FOR PURCHASE', G: 'FOOD AND BEVERAGES FOR PURCHASE', 'AVML': 'VEGETARIAN HINDU MEAL', 'BBML': 'BABY MEAL', 'BLML': 'BLAND MEAL', 'CHML': 'CHILD MEAL', 'CNML': 'CHICKEN MEAL (LY SPECIFIC)', 'DBML': 'DIABETIC MEAL', 'FPML': 'FRUIT PLATTER', 'FSML': 'FISH MEAL', 'GFML': 'GLUTEN INTOLERANT MEAL', 'HNML': 'HINDU (NON VEGETARIAN) MEAL', 'IVML': 'INDIAN VEGETARIAN MEAL', 'JPML': 'JAPANESE MEAL', 'KSML': 'KOSHER MEAL', 'LCML': 'LOW CALORIE MEAL', 'LFML': 'LOW FAT MEAL', 'LSML': 'LOW SALT MEAL', 'MOML': 'MUSLIM MEAL', 'NFML': 'NO FISH MEAL (LH SPECIFIC)', 'NLML': 'NON-LACTOSE MEAL', 'OBML': 'JAPANESE OBENTO MEAL (UA SPECIFIC)', 'RVML': 'VEGETARIAN RAW MEAL', 'SFML': 'SEA FOOD MEAL', 'SPML': 'SPECIAL MEAL, SPECIFY FOOD', 'VGML': 'VEGETARIAN VEGAN MEAL', 'VJML': 'VEGETARIAN JAIN MEAL', 'VLML': 'VEGETARIAN LACTO-OVO MEAL', 'VOML': 'VEGETARIAN ORIENTAL MEAL'
    };
    return mealMap[mealCode] || `${mealCode}`;
}

const historyManager = {
    // ... (This object remains unchanged)
    get: function () {
        return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    },
    save: function (history) {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                console.error("Could not save history: localStorage quota exceeded. The oldest history item will be removed.");
                history.pop();
                if (history.length > 0) {
                    this.save(history);
                }
            } else {
                console.error("Failed to save history:", e);
            }
        }
    },
    add: async function (data) {
        if (!data.success || !data.result?.flights?.length) return;
        const outputEl = document.getElementById('output').querySelector('.output-container');
        if (!outputEl) return;
        try {
            const canvas = await generateItineraryCanvas(outputEl);
            const screenshot = canvas.toDataURL('image/jpeg');
            let history = this.get();
            const currentPnrText = data.pnrText;
            const existingIndex = history.findIndex(item => item.pnrText === currentPnrText);
            if (existingIndex > -1) {
                history.splice(existingIndex, 1);
            }
            const newEntry = {
                id: Date.now(),
                pax: data.result.passengers.length ? data.result.passengers[0].split('/')[0] : 'Unknown Passenger',
                route: `${data.result.flights[0].departure.airport} - ${data.result.flights[data.result.flights.length - 1].arrival.airport}`,
                date: new Date().toISOString(),
                pnrText: currentPnrText,
                screenshot: screenshot
            };
            history.unshift(newEntry);
            if (history.length > 50) {
                history.pop();
            }
            this.save(history);
        } catch (err) {
            console.error('Failed to add history item:', err);
        }
    },
    render: function () {
        const listEl = document.getElementById('historyList');
        const search = document.getElementById('historySearchInput').value.toLowerCase();
        const sort = document.getElementById('historySortSelect').value;
        if (!listEl) return;
        let history = this.get();
        if (sort === 'oldest') history.reverse();
        if (search) {
            history = history.filter(item => item.pax.toLowerCase().includes(search) || item.route.toLowerCase().includes(search));
        }
        if (history.length === 0) {
            listEl.innerHTML =
                '<div class="info" style="margin: 10px;">No history found.</div>';
            return;
        }
        listEl.innerHTML = history.map(item => `
            <div class="history-item" data-id="${item.id}">
                <div class="history-item-info">
                    <div class="history-item-pax">
                        ${item.pax}
                    </div>
                    <div class="history-item-details">
                        <span style="font-weight:bold; color:black;">
                            ${item.route}
                        </span>
                        <br>
                        <span>
                            ${new Date(item.date).toLocaleString()}
                        </span>
                    </div>
                </div>
                <div class="history-item-actions">
                    <button class="use-history-btn">Use This</button>
                </div>
            </div>
            `).join('');
    },
    init: function () {
        document.getElementById('historyBtn')?.addEventListener('click', () => {
            this.render(); document.getElementById('historyModal')?.classList.remove('hidden');
        });
        document.getElementById('closeHistoryBtn')?.addEventListener('click', () => {
            document.getElementById('historyModal')?.classList.add('hidden');
            document.getElementById('historyPreviewPanel')?.classList.add('hidden');
        });
        document.getElementById('historySearchInput')?.addEventListener('input', () => this.render());
        document.getElementById('historySortSelect')?.addEventListener('change', () => this.render());
        document.getElementById('historyList')?.addEventListener('click', (e) => {
            const itemEl = e.target.closest('.history-item');
            if (!itemEl) return;
            const id = Number(itemEl.dataset.id);
            const entry = this.get().find(item => item.id === id);
            if (!entry) return;
            if (e.target.classList.contains('use-history-btn')) {
                document.getElementById('pnrInput').value = entry.pnrText;
                document.getElementById('historyModal').classList.add('hidden'); handleConvertClick();
            } else {
                const previewContent = document.getElementById('previewContent');
                previewContent.innerHTML = `<h4>Screenshot</h4><img src="${entry.screenshot}" alt="Itinerary Screenshot"><hr><h4>Raw PNR Data</h4><pre>${entry.pnrText}</pre>`;
                document.getElementById('historyPreviewPanel').classList.remove('hidden');
            }
        });
        document.getElementById('closePreviewBtn')?.addEventListener('click', (e) => {
            e.stopPropagation();
            document.getElementById('historyPreviewPanel').classList.add('hidden');

        });
    }
};

// --- EVENT LISTENERS & APP INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    loadOptions();
    historyManager.init();

    document.getElementById('convertBtn').addEventListener('click', handleConvertClick);

    document.getElementById('clearBtn').addEventListener('click', () => {
        document.getElementById('pnrInput').value = '';
        document.getElementById('output').innerHTML = '<div class="info">Enter PNR data and click Convert to begin.</div>';
        lastPnrResult = null;
        resetFareAndBaggageInputs();
        liveUpdateDisplay(false);
    });

    document.getElementById('pasteBtn').addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            document.getElementById('pnrInput').value = text;
            if (document.getElementById('autoConvertToggle').checked) {
                handleConvertClick();
            }
        } catch (err) { showPopup('Could not paste from clipboard.'); }
    });

    document.getElementById('editableToggle').addEventListener('change', () => {
        updateEditableState();
        saveOptions();
    });
    document.getElementById('autoConvertToggle').addEventListener('change', saveOptions);

    // --- MODIFIED: Removed #baggageUnitSelect from the general listener ---
    const allTheRest = '.options input, .fare-options-grid input, .fare-options-grid select, .baggage-options input, #baggageAmountInput';
    document.querySelectorAll(allTheRest).forEach(el => {
        const eventType = el.matches('input[type="checkbox"], input[type="radio"], select') ? 'change' : 'input';
        el.addEventListener(eventType, () => {
            saveOptions();

            if (el.id === 'showTaxes' || el.id === 'showFees') toggleFareInputsVisibility();
            if (el.id === 'showTransit') toggleTransitSymbolInputVisibility();

            if ((el.name === 'segmentTimeFormat' || el.name === 'transitTimeFormat') && lastPnrResult) {
                handleConvertClick();
            } else {
                liveUpdateDisplay();
            }
        });
    });

    // --- ADDED: Specific event listener for our new toggle switch ---
    document.getElementById('unit-selector-checkbox').addEventListener('change', () => {
        saveOptions();
        liveUpdateDisplay();
    });

    document.querySelectorAll('input[name="baggageOption"]').forEach(radio => {
        radio.addEventListener('change', () => {
            const showInputs = radio.value === 'particular';
        });
    });

    document.getElementById('customLogoInput').addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            localStorage.setItem(CUSTOM_LOGO_KEY, e.target.result);
            document.getElementById('customLogoPreview').src = e.target.result;
            document.getElementById('customLogoPreview').style.display = 'block';
            showPopup('Custom logo saved!');
            liveUpdateDisplay();
        };
        reader.readAsDataURL(file);
    });
    document.getElementById('customTextInput').addEventListener('input', debounce((event) => {
        localStorage.setItem(CUSTOM_TEXT_KEY, event.target.value);
        liveUpdateDisplay();
    }, 400));
    document.getElementById('clearCustomBrandingBtn').addEventListener('click', () => {
        if (confirm('Are you sure you want to clear your saved logo and text?')) {
            localStorage.removeItem(CUSTOM_LOGO_KEY);
            localStorage.removeItem(CUSTOM_TEXT_KEY);
            document.getElementById('customLogoInput').value = '';
            document.getElementById('customTextInput').value = '';
            document.getElementById('customLogoPreview').style.display = 'none';
            showPopup('Custom branding cleared.');
            liveUpdateDisplay();
        }
    });
    document.getElementById('showItineraryLogo').addEventListener('change', () => {
        toggleCustomBrandingSection();
        saveOptions();
        liveUpdateDisplay();
    });
    document.getElementById('screenshotBtn').addEventListener('click', async () => {
        const outputEl = document.getElementById('output').querySelector('.output-container');
        if (!outputEl) {
            showPopup('Nothing to capture.');
            return;
        } try {
            const canvas = await generateItineraryCanvas(outputEl);
            canvas.toBlob(blob => {
                navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                showPopup('Screenshot copied to clipboard!');
            }, 'image/png');
        } catch (err) {
            console.error("Screenshot failed:", err);
            showPopup('Could not copy screenshot.');
        }
    });
    document.getElementById('copyTextBtn').addEventListener('click', () => {
        const text = document.getElementById('output').innerText;
        navigator.clipboard.writeText(text).then(() => {
            showPopup('Itinerary copied as text!');
        }).catch(() => showPopup('Failed to copy text.'));
    });
});