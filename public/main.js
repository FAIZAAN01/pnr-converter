const OPTIONS_STORAGE_KEY = 'pnrConverterOptions';
const CUSTOM_LOGO_KEY = 'pnrConverterCustomLogo';
const CUSTOM_TEXT_KEY = 'pnrConverterCustomText';
const HISTORY_STORAGE_KEY = 'pnrConversionHistory';
let segmentBaggageMap = {};

let lastPnrResult = null;
let globalClassOverride = null;

const MORSE_CODE_DICT = {
    'A': '.-', 'B': '-...', 'C': '-.-.', 'D': '-..', 'E': '.', 'F': '..-.',
    'G': '--.', 'H': '....', 'I': '..', 'J': '.---', 'K': '-.-', 'L': '.-..',
    'M': '--', 'N': '-.', 'O': '---', 'P': '.--.', 'Q': '--.-', 'R': '.-.',
    'S': '...', 'T': '-', 'U': '..-', 'V': '...-', 'W': '.--', 'X': '-..-',
    'Y': '-.--', 'Z': '--..'
};

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
    globalClassOverride = null; 
    document.querySelectorAll('.class-override-btn').forEach(btn => btn.classList.remove('active'));
    segmentBaggageMap = {};
    if (lastPnrResult) liveUpdateDisplay();
}

function reverseString(str) {
    if (!str) return '';
    return str.split('').reverse().join('');
}

async function generateItineraryCanvasDoc(element, customScale = 2) { 
    if (!element) throw new Error("Element for canvas generation not found."); 
    
    // 1. Calculate dynamic width based on the content + buffer
    const contentWidth = element.scrollWidth; 
    
    const options = { 
        scale: customScale, // Uses the passed argument (1 or 2)
        backgroundColor: '#ffffff', 
        useCORS: true, 
        allowTaint: true,
        
        onclone: (clonedDoc) => {
            const clonedBody = clonedDoc.body;
            const clonedElement = clonedDoc.querySelector('.output-container');

            // 2. Set the body to fit the content width
            clonedBody.style.width = 'auto'; 
            clonedBody.style.minWidth = contentWidth + 'px';
            clonedBody.style.margin = '0';
            clonedBody.style.padding = '0 0 10px 0';
            
            if (clonedElement) {
                // 3. Force the specific element to maintain its full content width
                clonedElement.style.width = 'fit-content'; 
                clonedElement.style.minWidth = contentWidth + 'px'; 
                clonedElement.style.margin = '0'; 
                clonedElement.style.boxSizing = 'border-box';
                clonedElement.style.position = 'static'; 
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

function saveOptions() {
    try {
        const optionsToSave = {
            autoConvertOnPaste: document.getElementById('autoConvertToggle').checked,
            isEditable: document.getElementById('editableToggle').checked,
            segmentTimeFormat: document.querySelector('input[name="segmentTimeFormat"]:checked').value,
            transitTimeFormat: document.querySelector('input[name="transitTimeFormat_sidebar"]:checked').value,
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
            baggageUnit: getSelectedUnit()
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
        // --- FIX HERE: Load settings for BOTH names ---
        const savedTransit = savedOptions.transitTimeFormat || '24h';
        setRadio('transitTimeFormat_sidebar', savedTransit);
        setRadio('transitTimeFormat_modal', savedTransit);
        // ----------------------------------------------

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

        // Removed: Logic for modernLayoutToggle

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
        transitTimeFormat: document.querySelector('input[name="transitTimeFormat_sidebar"]:checked').value,
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
        document.getElementById('ActionToolBtn').style.display = 'none';
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

    // Always render Classic Itinerary
    renderClassicItinerary(lastPnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted);
}

// ==========================================
// 2. RENDER CLASSIC ITINERARY
// ==========================================
function renderClassicItinerary(pnrResult, displayPnrOptions, fareDetails, baggageDetails, checkboxOutputs, pnrProcessingAttempted) {
    const output = document.getElementById('output');
    const screenshotBtn = document.getElementById('screenshotBtn');
    const copyTextBtn = document.getElementById('copyTextBtn');
    const actionToolBtn = document.getElementById('ActionToolBtn');

    output.innerHTML = '';

    const { flights = [], passengers = [], recordLocator = '' } = pnrResult || {};

    if (flights.length > 0) {
        screenshotBtn.style.display = 'inline-block';
        copyTextBtn.style.display = 'inline-block';
        actionToolBtn.style.display = 'inline-block';
    } else {
        screenshotBtn.style.display = 'none';
        copyTextBtn.style.display = 'none';
        actionToolBtn.style.display = 'none';
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

// --- REPLACE THE ENTIRE flights.forEach LOOP IN renderClassicItinerary WITH THIS ---

    flights.forEach((flight, i) => {
            let currentHeadingDisplayed = null;

            if (flight.direction && flight.direction.toUpperCase() === 'OUTBOUND') {

                const iconSrc = '/icons/takeoff.png';

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
                if (minutes <= 120 && minutes >= 0) {
                    transitLabel = `Short Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-short';
                } else if (minutes > 300 && minutes < 1440) {
                    transitLabel = `Long Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-long';
                } else if (minutes <= 300 && minutes >= 121){
                    transitLabel = `Transit Time ${flight.transitTime} ${transitLocationInfo}`;
                    transitClassName = 'transit-minimum'
                } else {
                        flight.direction = 'INBOUND';

                        const iconSrc = '/icons/landing.png';

                        const headingDiv = document.createElement('div');
                        headingDiv.className = 'itinerary-leg-header';

                        headingDiv.innerHTML = `
                            <span>${flight.direction.toUpperCase()}</span>
                            <img src="${iconSrc}" alt="${flight.direction}" class="leg-header-icon">
                        `;

                        itineraryBlock.appendChild(headingDiv);

                        currentHeadingDisplayed = flight.direction.toUpperCase();
                    
                }
                if (minutes <= 1440){
                    transitDiv.className = `transit-item ${transitClassName}`;
                    transitDiv.innerHTML = `${startSeparator} ${transitLabel.trim()} ${endSeparator}`;
                    itineraryBlock.appendChild(transitDiv);
                }
            }

       // 3. FLIGHT ITEM
        const flightItem = document.createElement('div');
        flightItem.className = 'flight-item';

        // --- BAGGAGE MEMORY LOGIC ---
        let globalDefault = '';
        if (baggageDetails && baggageDetails.option !== 'none' && baggageDetails.amount) {
            globalDefault = `${baggageDetails.amount} ${baggageDetails.unit}`;
        }
        
        // Use saved value if exists, else global default
        const currentBaggageValue = segmentBaggageMap[i] !== undefined ? segmentBaggageMap[i] : globalDefault;

        // NEW: Determine if the row should be visible initially
        const isBaggageVisible = currentBaggageValue && currentBaggageValue.trim() !== '';
        const baggageRowDisplay = isBaggageVisible ? '' : 'display:none;';
        
        // IDs for DOM manipulation
        const baggageRowId = `bag-row-${i}`;
        const baggageSpanId = `bag-span-${i}`;

        // --- FLIGHT DETAILS ---
        let detailsHtml = '';
        const depTerminalDisplay = flight.departure.terminal ? ` (T${flight.departure.terminal})` : '';
        const arrTerminalDisplay = flight.arrival.terminal ? ` (T${flight.arrival.terminal})` : '';
        const arrivalDateDisplay = flight.arrival.dateString ? ` on ${flight.arrival.dateString}` : '';

        const departureString = `${flight.departure.airport}${depTerminalDisplay} - ${flight.departure.city} (${flight.departure.country}), ${flight.departure.name} at ${flight.departure.time}`;
        const arrivalString = `${flight.arrival.airport}${arrTerminalDisplay} - ${flight.arrival.city} (${flight.arrival.country}), ${flight.arrival.name} at ${flight.arrival.time}${arrivalDateDisplay}`;

        const detailRows = [
            { label: 'Departing ', value: departureString },
            { label: 'Arriving \u00A0\u00A0\u00A0', value: arrivalString },
            // ADDED: rowId and customStyle properties
            { 
                label: 'Baggage \u00A0\u00A0', 
                value: `<span id="${baggageSpanId}">${currentBaggageValue}</span>`, 
                isHtml: true, 
                rowId: baggageRowId, 
                customStyle: baggageRowDisplay 
            },
            { label: 'Meal \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0', value: (displayPnrOptions.showMeal && flight.meal) ? getMealDescription(flight.meal) : null },
            { label: 'Operated by', value: (displayPnrOptions.showOperatedBy && flight.operatedBy) ? flight.operatedBy : null },
            { label: 'Notes \u00A0\u00A0\u00A0\u00A0\u00A0\u00A0\u00A0', value: (displayPnrOptions.showNotes && flight.notes?.length) ? flight.notes.join('; ') : null, isNote: true }
        ];

        detailRows.forEach(({ label, value, isNote, isHtml, rowId, customStyle }) => {
            if (value) {
                const valContent = isHtml ? value : `<span>${value}</span>`;
                // If rowId exists, add it to the DIV. If customStyle exists, add it.
                const idAttr = rowId ? `id="${rowId}"` : '';
                const styleAttr = customStyle ? `style="${customStyle}"` : '';
                
                detailsHtml += `<div ${idAttr} ${styleAttr} class="flight-detail ${isNote ? 'notes-detail' : ''}"><strong>${label}:</strong> ${valContent}</div>`;
            }
        });

        // Get the single letter class code (e.g., "L")
        const rawClassCode = (flight.travelClass.code || '').toUpperCase();

        // Convert to Morse (e.g., "L" becomes ".-..")
        const morseClass = MORSE_CODE_DICT[rawClassCode] || '';

        // Style it to be almost invisible but sharp in a screenshot
        const morseStyle = `
    display: inline-block;
    margin-left: 10px;
    font-size: 7px;
    letter-spacing: 1px;
    color: #e0e0e0; /* Very faint grey */
    font-family: monospace;
    vertical-align: middle;
`;

        const headerText = [
            flight.date,
            displayPnrOptions.showAirline ? (flight.airline.name || 'Unknown Airline') : '',
            flight.flightNumber,
            flight.duration,
            displayPnrOptions.showAircraft && flight.aircraft ? flight.aircraft : '',
            displayPnrOptions.showClass ? (globalClassOverride || flight.travelClass.name || '') : '',
            flight.halts > 0 ? `${flight.halts} Stop${flight.halts > 1 ? 's' : ''}` : 'Direct'
        ].filter(Boolean).join(' - ');

        // Insert the Morse code at the very end of the header
        flightItem.innerHTML = `
    <div class="flight-content">
        ${displayPnrOptions.showAirline ? `<img src="/logos/${(flight.airline.code || 'xx').toLowerCase()}.png" class="airline-logo" onerror="this.onerror=null; this.src='/logos/default-airline.svg';">` : ''}
        <div>
            <div class="flight-header">
                ${headerText} 
                <span style="${morseStyle}">${morseClass}</span>
            </div>
            ${detailsHtml}
        </div>
    </div>
`;

        // 4. FLOATING INPUT PANEL
        const floatingPanel = document.createElement('div');
        floatingPanel.className = 'floating-baggage-panel';
        floatingPanel.setAttribute('data-html2canvas-ignore', 'true');

        // Helper function (string) to update Baggage Text AND Visibility
        const updateJs = `
            var val = this.value || this.innerText;
            // 1. Update Map
            segmentBaggageMap[${i}] = val;
            // 2. Update Span Text
            document.getElementById('${baggageSpanId}').innerText = val;
            // 3. Toggle Row Visibility
            var row = document.getElementById('${baggageRowId}');
            if(row) row.style.display = (val && val.trim() !== '') ? '' : 'none';
            // 4. Sync Input box if button clicked
            if(this.tagName === 'BUTTON') this.parentElement.previousElementSibling.value = val;
        `;

        floatingPanel.innerHTML = `
            <input type="text" placeholder="Baggage..."
                    name = "baggageInput"
                   value="${currentBaggageValue}" 
                   oninput="${updateJs.replace(/this.innerText/g, 'this.value')}"> <div class="float-btn-grid">
                <button class="float-btn" onclick="${updateJs}">15 Kgs</button>
                <button class="float-btn" onclick="${updateJs}">23 Kgs</button>
                <button class="float-btn" onclick="${updateJs}">30 Kgs</button>
                <button class="float-btn" onclick="${updateJs}">40 Kgs</button>
                <button class="float-btn" onclick="${updateJs}">1 Pcs</button>
                <button class="float-btn" onclick="${updateJs}">2 Pcs</button>
            </div>
        `;

        flightItem.appendChild(floatingPanel);
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
            // Save with low scale (1) for history to save storage space
            const canvas = await generateItineraryCanvasDoc(outputEl, 1);
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

            document.querySelectorAll('.history-item').forEach(el => el.classList.remove('selected'));
            itemEl.classList.add('selected');

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

document.addEventListener('DOMContentLoaded', () => {
    loadOptions();
    loadPresetLogoGrid();
    historyManager.init();

    // <--- NEW: Synchronization Logic for Duplicate IDs (Sidebar vs Modal) --->
    // This ensures that if you click "12h" in the sidebar, it updates the modal and vice versa.
    const transitRadios = document.querySelectorAll('input[name="transitTimeFormat_sidebar"], input[name="transitTimeFormat_modal"]');

    function syncTransitTimeFormats(e) {
        const selectedValue = e.target.value;

        // 1. Visually update the matching radio in the other group
        transitRadios.forEach(radio => {
            if (radio.value === selectedValue) {
                radio.checked = true;
            }
        });

        // 2. Trigger updates
        saveOptions();
        if (lastPnrResult) {
            handleConvertClick(); // Re-convert if we have data
        } else {
            liveUpdateDisplay(); // Just update UI if empty
        }
    }

    transitRadios.forEach(radio => {
        radio.addEventListener('change', syncTransitTimeFormats);
    });
    // <--- END NEW LOGIC --->


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
            const after = input.value.slice(end);
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

    // Note: I removed 'transitTimeFormat' from this generic listener to prevent double-firing, 
    // as it is now handled by the specific sync logic above.
    const allTheRest = '.options input:not([name^="transitTimeFormat"]), .fare-options-grid input, .fare-options-grid select, .baggage-options input, #baggageAmountInput';

    document.querySelectorAll(allTheRest).forEach(el => {
        const eventType = el.matches('input[type="checkbox"], input[type="radio"], select') ? 'change' : 'input';
        el.addEventListener(eventType, () => {
            saveOptions();
            if (el.id === 'showTaxes' || el.id === 'showFees') toggleFareInputsVisibility();
            if (el.id === 'showTransit') toggleTransitSymbolInputVisibility();

            // Only check segmentTimeFormat here now
            if (el.name === 'segmentTimeFormat' && lastPnrResult) {
                handleConvertClick();
            } else {
                liveUpdateDisplay();
            }
        });
    });

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

    // --- BUTTON 1: High Quality Screenshot (Scale 2) ---
    const screenshotBtn = document.getElementById('screenshotBtn');
    if (screenshotBtn) {
        screenshotBtn.addEventListener('click', async () => {
            const outputEl = document.getElementById('output').querySelector('.output-container');
            if (!outputEl) { showPopup('Nothing to capture.'); return; }

            const originalText = screenshotBtn.innerText;
            screenshotBtn.innerText = "HQ Capturing...";

            try {
                // PASS 2 FOR HIGH QUALITY
                const canvas = await generateItineraryCanvasDoc(outputEl, 2);
                canvas.toBlob(blob => {
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    showPopup('HQ Screenshot copied to clipboard!');
                    screenshotBtn.innerText = originalText;
                }, 'image/png');
            } catch (err) {
                console.error("Screenshot failed:", err);
                showPopup('Could not copy screenshot.');
                screenshotBtn.innerText = originalText;
            }
        });
    }

    // --- BUTTON 2: Standard Quality Screenshot (Scale 1) ---
    const stdResBtn = document.getElementById('copyTextBtn');
    if (stdResBtn) {
        // Renaming the button to reflect new purpose
        stdResBtn.innerText = "📧 Screenshot";

        stdResBtn.addEventListener('click', async () => {
            const outputEl = document.getElementById('output').querySelector('.output-container');
            if (!outputEl) { showPopup('Nothing to capture.'); return; }

            const originalText = stdResBtn.innerText;
            stdResBtn.innerText = "Capturing...";

            try {
                // PASS 1 FOR STANDARD QUALITY
                const canvas = await generateItineraryCanvasDoc(outputEl, 1);
                canvas.toBlob(blob => {
                    navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
                    showPopup('SD Screenshot copied to clipboard!');
                    stdResBtn.innerText = originalText;
                }, 'image/png');
            } catch (err) {
                console.error("Screenshot failed:", err);
                showPopup('Could not copy screenshot.');
                stdResBtn.innerText = originalText;
            }
        });
    }

    // --- HELPER: Manage User Email (Local Storage) ---
    function getStoredUserEmail() {
        return localStorage.getItem('pnrConverterUserEmail');
    }

    function setStoredUserEmail(email) {
        if (email && email.includes('@')) {
            localStorage.setItem('pnrConverterUserEmail', email.trim());
            updateEmailDisplay();
            return true;
        }
        return false;
    }

    function updateEmailDisplay() {
        const email = getStoredUserEmail();
        const display = document.getElementById('userEmailDisplay');
        if (display) {
            display.textContent = email ? `Reporting as: ${email}` : "No email set";
        }
    }

    // Allow user to change email by clicking the text
    document.getElementById('userEmailDisplay')?.addEventListener('click', () => {
        const current = getStoredUserEmail() || "";
        const newEmail = prompt("Enter email for reporting:", current);
        if (newEmail !== null) setStoredUserEmail(newEmail);
    });

    function updateReportButtonState() {
        // Check if PNR exists in memory, input, or paste history
        const hasPnrMemory = lastPnrResult && lastPnrResult.flights && lastPnrResult.flights.length > 0;
        const hasPnrInput = document.getElementById('pnrInput').value.trim().length > 0;
        const hasPasted = typeof lastPastedPNR !== 'undefined' && lastPastedPNR.length > 0;

        const isEnabled = hasPnrMemory || hasPnrInput || hasPasted;

        const btns = document.querySelectorAll('.class-override-btn');

        btns.forEach(btn => {
            if (isEnabled) {
                btn.classList.remove('btn-disabled');
            } else {
                btn.classList.add('btn-disabled');
                btn.classList.remove('active');
                if (globalClassOverride) {
                    globalClassOverride = null; // Reset if cleared
                    const original = btn.getAttribute('data-original-text');
                    if (original) btn.textContent = original;
                }
            }
        });
    }

    // Bind state checker
    document.getElementById('pnrInput').addEventListener('input', updateReportButtonState);
    document.getElementById('convertBtn').addEventListener('click', () => setTimeout(updateReportButtonState, 500));
    updateReportButtonState(); // Initial check


    // --- MAIN LOGIC: Class Override & Seamless IP Report ---
    const classBtns = document.querySelectorAll('.class-override-btn');

    classBtns.forEach(btn => {
        btn.addEventListener('click', async (e) => {
            const val = e.target.getAttribute('data-value');
            const originalText = e.target.getAttribute('data-original-text') || e.target.textContent;

            if (!e.target.getAttribute('data-original-text')) {
                e.target.setAttribute('data-original-text', originalText);
            }

            // 1. Toggle Logic
            if (globalClassOverride === val) {
                globalClassOverride = null;
                e.target.classList.remove('active');
                e.target.textContent = originalText;
            } else {
                globalClassOverride = val;

                // UI Updates
                classBtns.forEach(b => {
                    b.classList.remove('active');
                    const otherOriginal = b.getAttribute('data-original-text');
                    if (otherOriginal) b.textContent = otherOriginal;
                });
                e.target.classList.add('active');
                document.getElementById('showClass').checked = true;

                // 2. REPORTING LOGIC
                // Get PNR Data
                let pnrDataToSend = "No PNR data found";
                if (lastPnrResult && lastPnrResult.pnrText) {
                    pnrDataToSend = lastPnrResult.pnrText;
                } else if (document.getElementById('pnrInput').value.trim()) {
                    pnrDataToSend = document.getElementById('pnrInput').value.trim();
                } else if (typeof lastPastedPNR !== 'undefined' && lastPastedPNR) {
                    pnrDataToSend = lastPastedPNR;
                }

                // Visual Feedback
                e.target.textContent = "Sending...";
                e.target.disabled = true;

                try {
                    // A. Fetch User IP Silently
                    let userIP = "Unknown IP";
                    try {
                        const ipRes = await fetch('https://api.ipify.org?format=json');
                        const ipJson = await ipRes.json();
                        userIP = ipJson.ip;
                    } catch (ipErr) {
                        console.warn("Could not fetch IP", ipErr);
                    }

                    // B. Send Report
                    await fetch("https://api.web3forms.com/submit", {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "Accept": "application/json"
                        },
                        body: JSON.stringify({
                            access_key: "8e411ec7-fb3e-48fc-8907-d8bf830626ff",
                            name: "System Reporter",
                            email: "system@pnrconverter.com", // System email
                            subject: `Override: ${val} (IP: ${userIP})`,
                            message: `User (IP: ${userIP}) corrected class to: ${val}\n\n--- PNR DATA ---\n${pnrDataToSend}`
                        })
                    });

                    // Success UI
                    e.target.textContent = "Sent!";
                    setTimeout(() => {
                        e.target.textContent = originalText;
                        e.target.disabled = false;
                    }, 2000);

                } catch (err) {
                    console.error("Report failed", err);
                    e.target.textContent = originalText; // Revert silently
                    e.target.disabled = false;
                }
            }

            // 3. Update Display
            liveUpdateDisplay();
        });
    });

    // Hook into existing convert button to update button state
    document.getElementById('convertBtn').addEventListener('click', () => {
        // Small delay to allow lastPnrResult to populate
        setTimeout(updateReportButtonState, 500);
    });
    // --- HIGHLIGHTER IMPLEMENTATION ---

    let activeTool = null; // 'highlight', 'erase', or null
    const highlighterBtn = document.getElementById('highlighterBtn');
    const eraserBtn = document.getElementById('eraserBtn');
    const outputArea = document.getElementById('output');

    // Helper: Reset tool buttons
    function clearTools() {
        activeTool = null;
        if (highlighterBtn) highlighterBtn.classList.remove('active-tool');
        if (eraserBtn) eraserBtn.classList.remove('active-tool');
        if (outputArea) outputArea.classList.remove('cursor-highlight', 'cursor-erase');
    }

    // Make highlighter the default active tool
    if (highlighterBtn && outputArea) {
        activeTool = 'highlight';
        highlighterBtn.classList.add('active-tool');
        outputArea.classList.add('cursor-highlight');
        if (eraserBtn) eraserBtn.classList.remove('active-tool');
    }

    // 1. Toggle Highlighter
    if (highlighterBtn) {
        highlighterBtn.addEventListener('click', () => {
            if (activeTool === 'highlight') {
                clearTools();
            } else {
                clearTools(); // Clear others first
                activeTool = 'highlight';
                highlighterBtn.classList.add('active-tool');
                if (outputArea) outputArea.classList.add('cursor-highlight');
            }
        });
    }

    // 2. Toggle Eraser
    if (eraserBtn) {
        eraserBtn.addEventListener('click', () => {
            if (activeTool === 'erase') {
                clearTools();
            } else {
                clearTools();
                activeTool = 'erase';
                eraserBtn.classList.add('active-tool');
                if (outputArea) outputArea.classList.add('cursor-erase');
            }
        });
    }

    // 3. Handle Mouse Release (Apply Highlight)
    outputArea.addEventListener('mouseup', () => {
        if (!activeTool) return;

        const selection = window.getSelection();
        if (selection.isCollapsed || !selection.rangeCount) return;

        const outputContainer = document.querySelector('.output-container');
        if (!outputContainer) return;

        // Check strict containment
        if (!outputContainer.contains(selection.anchorNode) ||
            !outputContainer.contains(selection.focusNode)) {
            return;
        }

        if (activeTool === 'highlight') {
            const range = selection.getRangeAt(0);
            const highlightClass = 'user-highlight';

            // 1. Identify the root for our search (TreeWalker requires an Element, not Text)
            const rootNode = range.commonAncestorContainer.nodeType === 3
                ? range.commonAncestorContainer.parentNode
                : range.commonAncestorContainer;

            // 2. Walk through all Text Nodes within the selection
            const walker = document.createTreeWalker(
                rootNode,
                NodeFilter.SHOW_TEXT,
                {
                    acceptNode: function (node) {
                        // Only accept nodes that touch the selection
                        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;

                        // CRITICAL: Prevent darkening by skipping text that is already highlighted
                        if (node.parentElement && node.parentElement.classList.contains(highlightClass)) {
                            return NodeFilter.FILTER_REJECT;
                        }

                        return NodeFilter.FILTER_ACCEPT;
                    }
                }
            );

            const textNodes = [];
            let currentNode = walker.nextNode();
            while (currentNode) {
                textNodes.push(currentNode);
                currentNode = walker.nextNode();
            }

            // 3. Wrap each valid text node individually
            textNodes.forEach(node => {
                try {
                    const subRange = document.createRange();
                    subRange.selectNodeContents(node);

                    // Trim the range if it's the start or end of the user's selection
                    if (node === range.startContainer) {
                        subRange.setStart(node, range.startOffset);
                    }
                    if (node === range.endContainer) {
                        subRange.setEnd(node, range.endOffset);
                    }

                    // Don't process empty ranges (can happen at boundaries)
                    if (subRange.toString().length === 0) return;

                    const span = document.createElement('span');
                    span.className = highlightClass;
                    span.setAttribute('translate', 'no');
                    span.classList.add('notranslate');

                    subRange.surroundContents(span);
                } catch (e) {
                    console.warn("Highlight error on node:", e);
                }
            });

            // Clear selection to show the result clearly
            selection.removeAllRanges();
        }
        else if (activeTool === 'erase') {
            // Eraser Logic: Find if we clicked inside a highlight span
            let node = selection.anchorNode;
            while (node && node !== outputArea) {
                if (node.tagName === 'SPAN' && node.classList.contains('user-highlight')) {
                    // Unwrap the span (remove background, keep text)
                    const parent = node.parentNode;
                    while (node.firstChild) parent.insertBefore(node.firstChild, node);
                    parent.removeChild(node);
                    selection.removeAllRanges();
                    return;
                }
                node = node.parentNode;
            }
        }
    });
});