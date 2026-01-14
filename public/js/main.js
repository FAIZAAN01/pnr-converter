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

function resetFareAndBaggageInputs() {
    document.getElementById('adultFareInput').value = '';
    document.getElementById('childFareInput').value = '';
    document.getElementById('infantFareInput').value = '';
    document.getElementById('taxInput').value = '';
    document.getElementById('feeInput').value = '';
    document.getElementById('adultCountInput').value = '1';
    document.getElementById('childCountInput').value = '0';
    document.getElementById('infantCountInput').value = '0';
    document.getElementById('currencySelect').value = 'USD';
    document.getElementById('baggageParticular').checked = true;
    document.getElementById('baggageParticular').dispatchEvent(new Event('change'));
    if (lastPnrResult) liveUpdateDisplay();
}

function reverseString(str) {
    if (!str) return '';
    return str.split('').reverse().join('');
}

// --- SCREENSHOT FUNCTION (Fixed for Document Width) ---
async function generateItineraryCanvas(element) { 
    if (!element) throw new Error("Element for canvas generation not found."); 
    
    // THE GOLDILOCKS SETTINGS:
    const targetWidth = 800; // Force Standard Document Width
    const scaleFactor = 1;   // High Quality (Retina)

    const options = { 
        scale: scaleFactor, 
        backgroundColor: '#ffffff', 
        useCORS: true, 
        allowTaint: true,
        windowWidth: targetWidth,
        width: targetWidth,
        
        onclone: (clonedDoc) => {
            const clonedBody = clonedDoc.body;
            clonedBody.style.width = targetWidth + 'px';
            clonedBody.style.minWidth = targetWidth + 'px';
            clonedBody.style.maxWidth = targetWidth + 'px';
            clonedBody.style.margin = '0';
            clonedBody.style.padding = '0';
            
            const clonedElement = clonedDoc.querySelector('.output-container');
            if (clonedElement) {
                clonedElement.style.width = targetWidth + 'px';
                clonedElement.style.maxWidth = targetWidth + 'px';
                clonedElement.style.minWidth = targetWidth + 'px';
                clonedElement.style.margin = '0'; 
                clonedElement.style.boxSizing = 'border-box';
                clonedElement.style.position = 'absolute';
                clonedElement.style.left = '0';
                clonedElement.style.top = '0';
            }
        }
    }; 

    return await html2canvas(element, options); 
}

function getSelectedUnit() {
    const unitToggle = document.getElementById('unit-selector-checkbox');
    return unitToggle?.checked ? 'Pcs' : 'Kgs';
}

function getMealDescription(mealCode) {
    const mealMap = {
        B: 'BREAKFAST', K: 'CONTINENTAL BREAKFAST', L: 'LUNCH', D: 'DINNER', S: 'SNACK OR BRUNCH', O: 'COLD MEAL', H: 'HOT MEAL', M: 'MEAL (NON-SPECIFIC)', R: 'REFRESHMENT', C: 'ALCOHOLIC BEVERAGES COMPLIMENTARY', F: 'FOOD FOR PURCHASE', P: 'ALCOHOLIC BEVERAGES FOR PURCHASE', Y: 'DUTY FREE SALES AVAILABLE', N: 'NO MEAL SERVICE', V: 'REFRESHMENTS FOR PURCHASE', G: 'FOOD AND BEVERAGES FOR PURCHASE', 'AVML': 'VEGETARIAN HINDU MEAL', 'BBML': 'BABY MEAL', 'BLML': 'BLAND MEAL', 'CHML': 'CHILD MEAL', 'CNML': 'CHICKEN MEAL (LY SPECIFIC)', 'DBML': 'DIABETIC MEAL', 'FPML': 'FRUIT PLATTER', 'FSML': 'FISH MEAL', 'GFML': 'GLUTEN INTOLERANT MEAL', 'HNML': 'HINDU (NON VEGETARIAN) MEAL', 'IVML': 'INDIAN VEGETARIAN MEAL', 'JPML': 'JAPANESE MEAL', 'KSML': 'KOSHER MEAL', 'LCML': 'LOW CALORIE MEAL', 'LFML': 'LOW FAT MEAL', 'LSML': 'LOW SALT MEAL', 'MOML': 'MUSLIM MEAL', 'NFML': 'NO FISH MEAL (LH SPECIFIC)', 'NLML': 'NON-LACTOSE MEAL', 'OBML': 'JAPANESE OBENTO MEAL (UA SPECIFIC)', 'RVML': 'VEGETARIAN RAW MEAL', 'SFML': 'SEA FOOD MEAL', 'SPML': 'SPECIAL MEAL, SPECIFY FOOD', 'VGML': 'VEGETARIAN VEGAN MEAL', 'VJML': 'VEGETARIAN JAIN MEAL', 'VLML': 'VEGETARIAN LACTO-OVO MEAL', 'VOML': 'VEGETARIAN ORIENTAL MEAL'
    };
    return mealMap[mealCode] || `${mealCode}`;
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
            baggageUnit: getSelectedUnit(),
            useModernLayout: document.getElementById('modernLayoutToggle') ? document.getElementById('modernLayoutToggle').checked : false
        };
        localStorage.setItem(OPTIONS_STORAGE_KEY, JSON.stringify(optionsToSave));
    } catch (e) { console.error("Failed to save options:", e); }
}

function loadOptions() {
    try {
        const savedOptions = JSON.parse(localStorage.getItem(OPTIONS_STORAGE_KEY) || '{}');

        document.getElementById('autoConvertToggle').checked = savedOptions.autoConvertOnPaste ?? false;
        document.getElementById('editableToggle').checked = savedOptions.isEditable ?? false;

        const setRadio = (name, val) => {
            if (!val) return;
            const el = document.querySelector(`input[name="${name}"][value="${val}"]`);
            if (el) el.checked = true;
        };
        setRadio('segmentTimeFormat', savedOptions.segmentTimeFormat || '24h');
        setRadio('transitTimeFormat', savedOptions.transitTimeFormat || '24h');

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

        if(document.getElementById('modernLayoutToggle')) {
            document.getElementById('modernLayoutToggle').checked = savedOptions.useModernLayout ?? false;
        }

        if (savedOptions.currency) document.getElementById('currencySelect').value = savedOptions.currency;
        if (savedOptions.baggageUnit) document.getElementById('unit-selector-checkbox').checked = savedOptions.baggageUnit === 'pcs';
        document.getElementById('transitSymbolInput').value = savedOptions.transitSymbol ?? ':::::::';

        const customLogoData = localStorage.getItem(CUSTOM_LOGO_KEY);
        const customTextData = localStorage.getItem(CUSTOM_TEXT_KEY);
        if (customLogoData) {
            document.getElementById('customLogoPreview').src = customLogoData;
            document.getElementById('customLogoPreview').style.display = 'block';
        }
        if (customTextData) document.getElementById('customTextInput').value = customTextData;

        updateEditableState();
        toggleCustomBrandingSection();
        toggleFareInputsVisibility();
        toggleTransitSymbolInputVisibility();

    } catch (e) { console.error("Failed to load options:", e); }
}

function loadPresetLogoGrid() {
    const grid = document.getElementById("logoSelectGrid");
    const preview = document.getElementById("selectedLogoPreview");
    if (!grid) return;
    grid.innerHTML = "";
    const savedLogo = localStorage.getItem(CUSTOM_LOGO_KEY);

    PRESET_LOGOS.forEach((logo) => {
        const btn = document.createElement("div");
        btn.className = "logo-option";
        if (savedLogo === logo.url) btn.classList.add("selected");
        btn.innerHTML = `<img src="${logo.url}" alt="${logo.name}">`;
        btn.addEventListener("click", () => {
            document.querySelectorAll(".logo-option").forEach(el => el.classList.remove("selected"));
            btn.classList.add("selected");
            localStorage.setItem(CUSTOM_LOGO_KEY, logo.url);
            preview.src = logo.url;
            preview.style.display = "block";
            liveUpdateDisplay(true);
        });
        grid.appendChild(btn);
    });

    if (savedLogo) {
        preview.src = savedLogo;
        preview.style.display = "block";
    }
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
    if (pnrText.trim()) output.innerHTML = '';

    const options = {
        segmentTimeFormat: document.querySelector('input[name="segmentTimeFormat"]:checked').value,
        transitTimeFormat: document.querySelector('input[name="transitTimeFormat"]:checked').value,
    };

    try {
        const currentPnr = pnrText.trim() ? pnrText : (lastPnrResult?.pnrText || '');
        if (!currentPnr) throw new Error("No PNR data to process.");

        const response = await fetch('/api/convert', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pnrText: currentPnr, options: options })
        });

        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Server error: ${response.status}`);

        lastPnrResult = { ...data.result, pnrText: currentPnr };
        resetFareAndBaggageInputs();
        if (pnrText.trim()) document.getElementById('pnrInput').value = '';
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
            document.getElementById('output').innerHTML = '<div class="info" style="color: white">No flight segments found or PNR format not recognized.</div>';
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
        noShowRefundPolicy: document.getElementById('noShowRefundPolicy').checked,
        noShow: document.getElementById('noShow').checked
    };

    // --- SWITCH LOGIC ---
    const modernToggle = document.getElementById('modernLayoutToggle');
    const isModern = modernToggle && modernToggle.checked;

    if (isModern) {
        renderModernItinerary(lastPnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted);
    } else {
        renderClassicItinerary(lastPnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted);
    }
}

// ==========================================
// 1. RENDER MODERN ITINERARY
// ==========================================
function renderModernItinerary(pnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted) {
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
        if (pnrProcessingAttempted) output.innerHTML = '<div class="info">No flight segments found.</div>';
        else output.innerHTML = '<div class="info">Enter PNR data and click Convert to begin.</div>';
        return;
    }

    const outputContainer = document.createElement('div');
    outputContainer.className = 'output-container modern-layout';

    // A. Logo Section
    if (displayPnrOptions.showItineraryLogo) {
        const logoContainer = document.createElement('div');
        logoContainer.className = 'itinerary-main-logo-container';
        const logoImg = document.createElement('img');
        logoImg.className = 'itinerary-main-logo';
        logoImg.src = localStorage.getItem(CUSTOM_LOGO_KEY) || '/simbavoyages.png';
        const logoText = document.createElement('div');
        logoText.className = 'itinerary-logo-text';
        logoText.innerHTML = (localStorage.getItem(CUSTOM_TEXT_KEY) || "KN2 Ave 26, Nyarugenge Dist, Muhima<BR>Kigali Rwanda").replace(/\n/g, '<br>');
        logoContainer.appendChild(logoImg);
        logoContainer.appendChild(logoText);
        outputContainer.appendChild(logoContainer);
    }

    // B. Header (UPDATED FOR SAME-LINE DISPLAY)
    if (passengers.length > 0) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'itinerary-header';
        
        // We use Flexbox to put "Itinerary for: Name" on left and "Ref: CODE" on right
        let headerHTML = `<div style="display:flex; justify-content:space-between; align-items:flex-end;">`;
        
        // Left Side: Label + Names
        headerHTML += `<div>`;
        headerHTML += `<h4 style="margin:0 0 5px 0;">Passengers</h4>`;
        headerHTML += `<p style="margin:0;">${passengers.join(', ')}</p>`;
        headerHTML += `</div>`;

        // Right Side: Booking Ref (If exists)
        if (recordLocator) {
            headerHTML += `<div style="text-align:right;">`;
            headerHTML += `<h4 style="margin:0 0 5px 0;">Booking Ref</h4>`;
            headerHTML += `<p style="margin:0; font-family:monospace; font-size:18px;">${recordLocator}</p>`;
            headerHTML += `</div>`;
        }
        
        headerHTML += `</div>`;
        headerDiv.innerHTML = headerHTML;
        outputContainer.appendChild(headerDiv);
    }

    // C. Flights
    const itineraryBlock = document.createElement('div');
    itineraryBlock.className = 'itinerary-block';

    flights.forEach((flight, i) => {
        if (flight.direction && (i === 0 || flight.direction !== flights[i-1].direction)) {
            const headingDiv = document.createElement('div');
            headingDiv.className = 'itinerary-leg-header';
            const iconType = flight.direction.toUpperCase() === 'INBOUND' ? 'landing.png' : 'takeoff.png';
            headingDiv.innerHTML = `<img src="/icons/${iconType}" class="leg-header-icon"> <span>${flight.direction}</span>`;
            itineraryBlock.appendChild(headingDiv);
        }

        if (displayPnrOptions.showTransit && i > 0 && flight.transitTime && flight.transitDurationMinutes) {
            const minutes = flight.transitDurationMinutes;
            let transitClass = '';
            if (minutes > 300) transitClass = 'long';
            const transitDiv = document.createElement('div');
            transitDiv.className = 'transit-container';
            transitDiv.innerHTML = `<div class="transit-pill ${transitClass}">⏱ ${flight.transitTime} Layover in ${flights[i - 1].arrival?.city || 'Transit'}</div>`;
            itineraryBlock.appendChild(transitDiv);
        }

        const flightCard = document.createElement('div');
        flightCard.className = 'flight-item';

        let baggageText = '';
        if (baggageDetails && baggageDetails.option !== 'none' && baggageDetails.amount) {
            baggageText = `${baggageDetails.amount} ${baggageDetails.unit}`;
        }

        const airlineName = displayPnrOptions.showAirline ? (flight.airline.name || '') : '';
        const airlineLogo = displayPnrOptions.showAirline ? `<img src="/logos/${(flight.airline.code || 'xx').toLowerCase()}.png" class="airline-logo" onerror="this.style.display='none'">` : '';

        flightCard.innerHTML = `
            <div class="flight-card-top">
                <div class="flight-date-badge">📅 ${flight.date}</div>
                <div class="flight-airline-name">${airlineName} ${flight.flightNumber}</div>
            </div>
            <div class="flight-card-main">
                ${airlineLogo}
                <div class="route-col left">
                    <span class="time-big">${flight.departure.time}</span>
                    <span class="airport-big">${flight.departure.airport}</span>
                    <span class="city-small">${flight.departure.city}</span>
                    <span class="city-small">T${flight.departure.terminal || '-'}</span>
                </div>
                <div class="route-visual">
                    <span style="font-size:12px; color:#999; font-weight:600">⏳ ${flight.duration}</span>
                    <div class="visual-line"></div>
                    <span style="font-size:10px; color:#999">${flight.halts > 0 ? flight.halts + ' Stop(s)' : 'Direct'}</span>
                </div>
                <div class="route-col right">
                    <span class="time-big">${flight.arrival.time}</span>
                    <span class="airport-big">${flight.arrival.airport}</span>
                    <span class="city-small">${flight.arrival.city}</span>
                    <span class="city-small">T${flight.arrival.terminal || '-'}</span>
                </div>
            </div>
            <div class="flight-card-footer">
                ${displayPnrOptions.showClass ? `<span class="detail-pill">💺 ${flight.travelClass.name}</span>` : ''}
                ${baggageText ? `<span class="detail-pill">🧳 ${baggageText}</span>` : ''}
                ${displayPnrOptions.showAircraft && flight.aircraft ? `<span class="detail-pill">✈️ ${flight.aircraft}</span>` : ''}
                ${displayPnrOptions.showMeal && flight.meal ? `<span class="detail-pill">🍽 ${getMealDescription(flight.meal)}</span>` : ''}
                ${displayPnrOptions.showOperatedBy && flight.operatedBy ? `<span class="detail-pill">ℹ️ Op: ${flight.operatedBy}</span>` : ''}
                ${(displayPnrOptions.showNotes && flight.notes?.length) ? `<span class="detail-pill" style="background:#fff3cd; color:#856404; width:100%">📝 ${flight.notes.join('; ')}</span>` : ''}
            </div>
        `;
        itineraryBlock.appendChild(flightCard);
    });

    const notesContainer = document.createElement('div');
    let notesHtml = getCheckboxNotesHtml(checkboxOutputs);
    if (notesHtml) {
        notesContainer.innerHTML = `<div style="background:#fff; padding:15px; border-radius:12px; margin-top:20px"><strong style="color:#e74c3c">Ticket Conditions:</strong>\n${notesHtml}</div>`;
        itineraryBlock.appendChild(notesContainer);
    }

    const { adultCount, adultFare, childCount, childFare, infantCount, infantFare, tax, fee, currency, showTaxes, showFees } = fareDetails || {};
    const totalPax = (parseInt(adultCount)||0) + (parseInt(childCount)||0) + (parseInt(infantCount)||0);

    if (totalPax > 0) {
        const adultCountNum = parseInt(adultCount) || 0;
        const adultFareNum = parseFloat(adultFare) || 0;
        const adultBaseTotal = adultCountNum * adultFareNum;
        const childCountNum = parseInt(childCount) || 0;
        const childFareNum = parseFloat(childFare) || 0;
        const childBaseTotal = childCountNum * childFareNum;
        const infantCountNum = parseInt(infantCount) || 0;
        const infantFareNum = parseFloat(infantFare) || 0;
        const infantBaseTotal = infantCountNum * infantFareNum;
        const taxNum = parseFloat(tax) || 0;
        const totalTaxes = showTaxes ? totalPax * taxNum : 0;
        const feeNum = parseFloat(fee) || 0;
        const totalFees = showFees ? totalPax * feeNum : 0;
        const currencySymbol = currency || 'USD';
        
        const grandTotal = adultBaseTotal + childBaseTotal + infantBaseTotal + totalTaxes + totalFees;

        if (grandTotal > 0) {
            let fareLines = [];
            if (adultBaseTotal > 0) fareLines.push(`Adults (${adultCountNum} x ${adultFareNum.toFixed(2)}): ${adultBaseTotal.toFixed(2)}`);
            if (childBaseTotal > 0) fareLines.push(`Children (${childCountNum} x ${childFareNum.toFixed(2)}): ${childBaseTotal.toFixed(2)}`);
            if (infantBaseTotal > 0) fareLines.push(`Infants (${infantCountNum} x ${infantFareNum.toFixed(2)}): ${infantBaseTotal.toFixed(2)}`);
            if (showTaxes && totalTaxes > 0) fareLines.push(`Taxes: ${totalTaxes.toFixed(2)}`);
            if (showFees && totalFees > 0) fareLines.push(`Fees: ${totalFees.toFixed(2)}`);
            
            const fareDiv = document.createElement('div');
            fareDiv.className = 'fare-summary-card';
            fareDiv.innerHTML = `
                <div style="border-bottom:1px solid rgba(255,255,255,0.2); padding-bottom:5px; margin-bottom:5px;"><strong>FARE BREAKDOWN (${currencySymbol})</strong></div>
                ${fareLines.join('<br>')}
                <div style="font-size:18px; font-weight:bold; margin-top:10px; color:#2ecc71;">TOTAL: ${grandTotal.toFixed(2)}</div>
            `;
            itineraryBlock.appendChild(fareDiv);
        }
    }

    outputContainer.appendChild(itineraryBlock);
    output.appendChild(outputContainer);
}

// ==========================================
// 2. RENDER CLASSIC ITINERARY
// ==========================================
function renderClassicItinerary(pnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted) {
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
        if (pnrProcessingAttempted) output.innerHTML = '<div class="info">No flight segments found.</div>';
        else output.innerHTML = '<div class="info">Enter PNR data and click Convert to begin.</div>';
        return;
    }

    const outputContainer = document.createElement('div');
    outputContainer.className = 'output-container';

    if (displayPnrOptions.showItineraryLogo) {
        const logoContainer = document.createElement('div');
        logoContainer.className = 'itinerary-main-logo-container';
        const logoImg = document.createElement('img');
        logoImg.className = 'itinerary-main-logo';
        logoImg.src = localStorage.getItem(CUSTOM_LOGO_KEY) || '/simbavoyages.png';
        const logoText = document.createElement('div');
        logoText.className = 'itinerary-logo-text';
        logoText.innerHTML = (localStorage.getItem(CUSTOM_TEXT_KEY) || "KN2 Ave 26, Nyarugenge Dist, Muhima<BR>Kigali Rwanda").replace(/\n/g, '<br>');
        logoContainer.appendChild(logoImg);
        logoContainer.appendChild(logoText);
        outputContainer.appendChild(logoContainer);
    }

    // B. Header (UPDATED FOR SAME-LINE DISPLAY)
    if (passengers.length > 0) {
        const headerDiv = document.createElement('div');
        headerDiv.className = 'itinerary-header';
        
        let headerHTML = `<div style="display:flex; justify-content:space-between; align-items:flex-end;">`;
        
        // Left: Label + Name
        headerHTML += `<div>`;
        headerHTML += `<h4 style="margin:0 0 5px 0;">Itinerary For:</h4>`;
        headerHTML += `<p style="margin:0;">${passengers.join('<br>')}</p>`;
        headerHTML += `</div>`;
        
        // Right: Booking Ref
        if (recordLocator) {
            headerHTML += `<div style="text-align:right;">`;
            headerHTML += `<h4 style="margin:0 0 5px 0;">Booking Ref:</h4>`;
            headerHTML += `<p style="margin:0; font-family:monospace; font-size:16px;">${recordLocator}</p>`;
            headerHTML += `</div>`;
        }
        
        headerHTML += `</div>`;
        headerDiv.innerHTML = headerHTML;
        outputContainer.appendChild(headerDiv);
    }

    const itineraryBlock = document.createElement('div');
    itineraryBlock.className = 'itinerary-block';

    flights.forEach((flight, i) => {
        if (flight.direction && flight.direction.toUpperCase() === 'OUTBOUND') {
            const iconSrc = '/icons/takeoff.png';
            const headingDiv = document.createElement('div');
            headingDiv.className = 'itinerary-leg-header';
            headingDiv.innerHTML = `<span>${flight.direction.toUpperCase()}</span><img src="${iconSrc}" class="leg-header-icon">`;
            itineraryBlock.appendChild(headingDiv);
        }

        if (displayPnrOptions.showTransit && i > 0 && flight.transitTime && flight.transitDurationMinutes) {
            const transitDiv = document.createElement('div');
            const minutes = flight.transitDurationMinutes;
            const rawSymbol = displayPnrOptions.transitSymbol || ':::::::';
            const startSeparator = rawSymbol.replace(/ /g, ' ');
            const endSeparator = reverseString(rawSymbol).replace(/ /g, ' ');
            const transitLocationInfo = `at ${flights[i - 1].arrival?.city || ''} (${flights[i - 1].arrival?.airport || ''})`;

            let transitLabel, transitClassName;
            if (minutes <= 120 && minutes >= 0) {
                transitLabel = `Short Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                transitClassName = 'transit-short';
            } else if (minutes > 300 && minutes < 1440) {
                transitLabel = `Long Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                transitClassName = 'transit-long';
            } else if (minutes <= 300 && minutes >= 121) {
                transitLabel = `Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                transitClassName = 'transit-minimum'
            } else {
                flight.direction = 'INBOUND';
                const iconSrc = '/icons/landing.png';
                const headingDiv = document.createElement('div');
                headingDiv.className = 'itinerary-leg-header';
                headingDiv.innerHTML = `<span>${flight.direction.toUpperCase()}</span><img src="${iconSrc}" class="leg-header-icon">`;
                itineraryBlock.appendChild(headingDiv);
            }
            if (minutes <= 1440) {
                transitDiv.className = `transit-item ${transitClassName}`;
                transitDiv.innerHTML = `${startSeparator} ${transitLabel.trim()} ${endSeparator}`;
                itineraryBlock.appendChild(transitDiv);
            }
        }

        const flightItem = document.createElement('div');
        flightItem.className = 'flight-item';

        let detailsHtml = '';
        let baggageText = '';
        if (baggageDetails && baggageDetails.option !== 'none' && baggageDetails.amount) {
            baggageText = `${baggageDetails.amount}\u00A0${baggageDetails.unit}`;
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
            if (value) detailsHtml += `<div class="flight-detail ${isNote ? 'notes-detail' : ''}"><strong>${label}:</strong> <span>${value}</span></div>`;
        });

        const headerText = [
            flight.date,
            displayPnrOptions.showAirline ? (flight.airline.name || 'Unknown Airline') : '',
            flight.flightNumber, flight.duration,
            displayPnrOptions.showAircraft && flight.aircraft ? flight.aircraft : '',
            displayPnrOptions.showClass && flight.travelClass.name ? flight.travelClass.name : '',
            flight.halts > 0 ? `${flight.halts} Stop${flight.halts > 1 ? 's' : ''}` : 'Direct'
        ].filter(Boolean).join(' - ');

        flightItem.innerHTML = `<div class="flight-content">${displayPnrOptions.showAirline ? `<img src="/logos/${(flight.airline.code || 'xx').toLowerCase()}.png" class="airline-logo" alt="${flight.airline.name} logo" onerror="this.onerror=null; this.src='/logos/default-airline.svg';">` : ''}<div><div class="flight-header">${headerText}</div>${detailsHtml}</div></div>`;
        itineraryBlock.appendChild(flightItem);
    });

    const notesContainer = document.createElement('div');
    notesContainer.className = 'itinerary-notes';
    let notesHtml = getCheckboxNotesHtml(checkboxOutputs);
    
    const { adultCount, adultFare, childCount, childFare, infantCount, infantFare, tax, fee, currency, showTaxes, showFees } = fareDetails || {};
    const totalPax = (parseInt(adultCount)||0) + (parseInt(childCount)||0) + (parseInt(infantCount)||0);

    if (totalPax > 0) {
        const adultCountNum = parseInt(adultCount) || 0;
        const adultFareNum = parseFloat(adultFare) || 0;
        const adultBaseTotal = adultCountNum * adultFareNum;
        const childCountNum = parseInt(childCount) || 0;
        const childFareNum = parseFloat(childFare) || 0;
        const childBaseTotal = childCountNum * childFareNum;
        const infantCountNum = parseInt(infantCount) || 0;
        const infantFareNum = parseFloat(infantFare) || 0;
        const infantBaseTotal = infantCountNum * infantFareNum;
        const taxNum = parseFloat(tax) || 0;
        const totalTaxes = showTaxes ? totalPax * taxNum : 0;
        const feeNum = parseFloat(fee) || 0;
        const totalFees = showFees ? totalPax * feeNum : 0;
        const currencySymbol = currency || 'USD';
        
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
    output.appendChild(outputContainer);
}

// --- HELPER FOR NOTES ---
function getCheckboxNotesHtml(checkboxOutputs) {
    let notesHtml = '';
    if (checkboxOutputs.showCovidNotice) notesHtml += `<p> <strong>&#9830</strong> Date Change Allowed With Applicable Penalties.</p>`;
    if (checkboxOutputs.showTravelInsurance) notesHtml += `<p> <strong>&#9830</strong> Before Departure Changes Are Allowed With Applicable Penalty.</p>`;
    if (checkboxOutputs.showVisaInfo) notesHtml += `<p> <strong>&#9830</strong> Before Departure Refundable With Applicable Penalties.</p>`;
    if (checkboxOutputs.dontShowTravelInsurance) notesHtml += `<p> <strong>&#9830</strong> After Departure Non Refundable.</p>`;
    if (checkboxOutputs.noShowRefundPolicy) notesHtml += `<p> <strong>&#9830</strong> Refundable With Applicable Penalties.</p>`;
    if (checkboxOutputs.showHealthDocs) notesHtml += `<p> <strong>&#9830</strong> Non Refundable.</p>`;
    if (checkboxOutputs.noShow) notesHtml += `<p> <strong>&#9830</strong> No Show Fee Where Applicable.</p>`;
    return notesHtml;
}

const historyManager = {
    get: function () {
        return JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || '[]');
    },
    save: function (history) {
        try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
        } catch (e) {
            if (e.name === 'QuotaExceededError') {
                history.pop();
                if (history.length > 0) this.save(history);
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
            if (existingIndex > -1) history.splice(existingIndex, 1);
            const newEntry = {
                id: Date.now(),
                pax: data.result.passengers.length ? data.result.passengers[0].split('/')[0] : 'Unknown Passenger',
                route: `${data.result.flights[0].departure.airport} - ${data.result.flights[data.result.flights.length - 1].arrival.airport}`,
                date: new Date().toISOString(),
                pnrText: currentPnrText,
                screenshot: screenshot
            };
            history.unshift(newEntry);
            if (history.length > 50) history.pop();
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
        if (search) history = history.filter(item => item.pax.toLowerCase().includes(search) || item.route.toLowerCase().includes(search));
        if (history.length === 0) {
            listEl.innerHTML = '<div class="info" style="margin: 10px;">No history found.</div>';
            return;
        }
        listEl.innerHTML = history.map(item => `
            <div class="history-item" data-id="${item.id}">
                <div class="history-item-info">
                    <div class="history-item-pax">${item.pax}</div>
                    <div class="history-item-details">
                        <span style="font-weight:bold;">${item.route}</span><br>
                        <span>${new Date(item.date).toLocaleString()}</span>
                    </div>
                </div>
                <div class="history-item-actions"><button class="use-history-btn">Use This</button></div>
            </div>`).join('');
    },
    init: function () {
        const historyModal = document.getElementById('historyModal');
        const historyContent = historyModal.querySelector('.modal-content');

        document.getElementById('historyBtn')?.addEventListener('click', () => {
            this.render();
            historyModal.classList.remove('hidden');
        });

        document.getElementById('closeHistoryBtn')?.addEventListener('click', () => {
            historyModal.classList.add('hidden');
            document.getElementById('historyPreviewPanel')?.classList.add('hidden');
        });

        historyModal.addEventListener('click', (e) => {
            if (!historyContent.contains(e.target)) {
                historyModal.classList.add('hidden');
                document.getElementById('historyPreviewPanel')?.classList.add('hidden');
            }
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
                historyModal.classList.add('hidden');
            } else {
                const previewContent = document.getElementById('previewContent');
                previewContent.innerHTML = `<h4>Screenshot</h4><img src="${entry.screenshot}" alt="Itinerary Screenshot"><hr><button class="copy-btn" data-copy-target=".text2" style="color:black">Click to Copy Raw PNR Data</button><pre class="text2">${entry.pnrText}</pre>`;
                document.getElementById('historyPreviewPanel').classList.remove('hidden');
                document.addEventListener('click', function(e) {
                    if(e.target.matches('.copy-btn')) {
                        const targetSelector = e.target.getAttribute('data-copy-target');
                        const target = document.querySelector(targetSelector);
                        if(target) {
                            navigator.clipboard.writeText(target.textContent.trim()).then(() => {
                            e.target.textContent = 'Copied!';
                            setTimeout(() => e.target.textContent = 'Copy', 1000);
                            });
                        }
                    }
                });
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
    loadPresetLogoGrid();
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
        const input = document.getElementById('pnrInput');
        try {
            const pastedText = await navigator.clipboard.readText();
            if (!pastedText) return;
            const start = input.selectionStart;
            const end = input.selectionEnd;
            const before = input.value.slice(0, start);
            const after  = input.value.slice(end);
            input.value = before + pastedText + after;
            const newPos = start + pastedText.length;
            input.setSelectionRange(newPos, newPos);
            const data = new DataTransfer();
            data.setData("text/plain", pastedText);
            const pasteEvent = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
            input.dispatchEvent(pasteEvent);
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.focus();
            if (document.getElementById('autoConvertToggle')?.checked) handleConvertClick();
        } catch (err) { showPopup("Clipboard access blocked!"); }
    });

    document.getElementById('editableToggle').addEventListener('change', () => { updateEditableState(); saveOptions(); });
    document.getElementById('autoConvertToggle').addEventListener('change', saveOptions);

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

    // NEW TOGGLE
    if(document.getElementById('modernLayoutToggle')){
        document.getElementById('modernLayoutToggle').addEventListener('change', () => {
            saveOptions();
            liveUpdateDisplay();
        });
    }

    document.getElementById('unit-selector-checkbox').addEventListener('change', () => { saveOptions(); liveUpdateDisplay(); });

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
        if (!outputEl) { showPopup('Nothing to capture.'); return; }
        try {
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