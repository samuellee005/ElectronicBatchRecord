// Data Entry JavaScript
let pdfDoc = null;
let currentPage = 1;
let totalPages = 1;
let scale = 1.5;
let formConfig = null;
let formData = {};
let signaturePads = {};

// Initialize PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Initialize data entry
async function initDataEntry(formId, pdfFile) {
    try {
        // Load form configuration
        let formUrl = '';
        if (formId) {
            formUrl = `includes/load-form-by-id.php?id=${encodeURIComponent(formId)}`;
        } else if (pdfFile) {
            formUrl = `includes/load-form.php?pdf=${encodeURIComponent(pdfFile)}`;
        }

        const formResponse = await fetch(formUrl);
        const formResult = await formResponse.json();

        if (!formResult.success || !formResult.form) {
            showError('Form configuration not found');
            return;
        }

        formConfig = formResult.form;
        displayFormInfo(formConfig);

        // Load PDF
        const pdfPath = `uploads/${formConfig.pdfFile}`;
        const loadingTask = pdfjsLib.getDocument(pdfPath);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        await renderPage(1);
        updatePaginationControls();
        renderFormFields();
    } catch (error) {
        console.error('Error initializing data entry:', error);
        showError('Error loading form: ' + error.message);
    }
}

// Display form information
function displayFormInfo(config) {
    const formInfo = document.getElementById('formInfo');
    formInfo.innerHTML = `
        <h2>${escapeHtml(config.name)}</h2>
        ${config.description ? `<p>${escapeHtml(config.description)}</p>` : ''}
        <p><strong>PDF:</strong> ${escapeHtml(config.pdfFile)}</p>
        <p><strong>Fields:</strong> ${config.fields ? config.fields.length : 0}</p>
    `;
}

// Render PDF page
async function renderPage(pageNum) {
    if (pageNum < 1 || pageNum > totalPages) return;

    currentPage = pageNum;
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: scale });

    const canvas = document.getElementById('pdf-canvas');
    const context = canvas.getContext('2d');

    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderContext = {
        canvasContext: context,
        viewport: viewport
    };

    await page.render(renderContext).promise;

    // Update overlay layer size
    const overlayLayer = document.getElementById('overlayLayer');
    overlayLayer.style.width = viewport.width + 'px';
    overlayLayer.style.height = viewport.height + 'px';

    // Re-render form fields for current page
    renderFormFields();
    updatePaginationControls();
}

// Change page
function changePage(delta) {
    const newPage = currentPage + delta;
    if (newPage >= 1 && newPage <= totalPages) {
        renderPage(newPage);
    }
}

// Update pagination controls
function updatePaginationControls() {
    const paginationDiv = document.getElementById('pdfPagination');
    const prevBtn = document.getElementById('prevPage');
    const nextBtn = document.getElementById('nextPage');
    const pageInfo = document.getElementById('pageInfo');

    if (totalPages > 1) {
        paginationDiv.style.display = 'flex';
        prevBtn.disabled = currentPage === 1;
        nextBtn.disabled = currentPage === totalPages;
        pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
    } else {
        paginationDiv.style.display = 'none';
    }
}

// Render form fields
function renderFormFields() {
    if (!formConfig || !formConfig.fields) return;

    const overlayLayer = document.getElementById('overlayLayer');
    overlayLayer.innerHTML = '';

    // Only show fields for the current page (default to page 1 if page property doesn't exist)
    const currentPageFields = formConfig.fields.filter(field => {
        const fieldPage = field.page || 1; // Default to page 1 for fields without page property
        return fieldPage === currentPage;
    });

    currentPageFields.forEach(field => {
        const fieldElement = createFieldElement(field);
        overlayLayer.appendChild(fieldElement);
    });
}

// Create field element for data entry
function createFieldElement(field) {
    const div = document.createElement('div');
    div.className = 'form-field';
    div.style.left = field.x + 'px';
    div.style.top = field.y + 'px';
    div.style.width = field.width + 'px';
    div.style.height = field.height + 'px';

    const label = document.createElement('div');
    label.className = 'form-field-label';
    label.innerHTML = escapeHtml(field.label || 'Field') + (field.required ? '<span class="required-marker">*</span>' : '');
    div.appendChild(label);

    const inputContainer = document.createElement('div');
    inputContainer.style.height = 'calc(100% - 20px)';

    const input = createInputForField(field);
    inputContainer.appendChild(input);
    div.appendChild(inputContainer);

    return div;
}

// Create input element based on field type
function createInputForField(field) {
    const fieldId = field.id;

    switch(field.type) {
        case 'text':
            const textInput = document.createElement('input');
            textInput.type = 'text';
            textInput.className = 'form-field-input';
            textInput.placeholder = field.placeholder || '';
            textInput.required = field.required || false;
            textInput.value = formData[fieldId] || '';
            textInput.onchange = () => formData[fieldId] = textInput.value;
            return textInput;

        case 'date':
            const dateInput = document.createElement('input');
            dateInput.type = 'date';
            dateInput.className = 'form-field-input';
            dateInput.required = field.required || false;
            dateInput.value = formData[fieldId] || '';
            dateInput.onchange = () => formData[fieldId] = dateInput.value;
            return dateInput;

        case 'number':
            const numContainer = document.createElement('div');
            numContainer.className = 'unit-input-group';
            numContainer.style.height = '100%';
            numContainer.style.display = 'flex';
            numContainer.style.alignItems = 'stretch';

            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.className = 'form-field-input';
            numInput.placeholder = field.placeholder || '';
            numInput.required = field.required || false;
            numInput.style.flex = '1';
            numInput.value = formData[fieldId] || '';
            numInput.onchange = () => formData[fieldId] = numInput.value;
            numContainer.appendChild(numInput);

            if (field.unit) {
                const unitDisplay = document.createElement('div');
                unitDisplay.className = 'unit-display';
                unitDisplay.textContent = field.unit;
                numContainer.appendChild(unitDisplay);
            }

            return numContainer;

        case 'signature':
            const sigContainer = document.createElement('div');
            sigContainer.className = 'signature-container';
            sigContainer.style.width = '100%';
            sigContainer.style.height = '100%';
            sigContainer.style.display = 'flex';
            sigContainer.style.flexDirection = 'column';
            sigContainer.style.minHeight = '100px';

            // Create canvas wrapper
            const canvasWrapper = document.createElement('div');
            canvasWrapper.style.width = '100%';
            canvasWrapper.style.height = 'calc(100% - 35px)';
            canvasWrapper.style.minHeight = '100px';
            canvasWrapper.style.position = 'relative';
            canvasWrapper.style.border = '1px solid #ccc';
            canvasWrapper.style.borderRadius = '4px';
            canvasWrapper.style.background = '#ffffff';
            canvasWrapper.style.cursor = 'crosshair';

            const sigCanvas = document.createElement('canvas');
            sigCanvas.className = 'signature-canvas';
            sigCanvas.style.width = '100%';
            sigCanvas.style.height = '100%';
            sigCanvas.style.display = 'block';
            sigCanvas.style.touchAction = 'none';
            canvasWrapper.appendChild(sigCanvas);
            sigContainer.appendChild(canvasWrapper);

            const sigControls = document.createElement('div');
            sigControls.className = 'signature-controls';
            sigControls.style.marginTop = '5px';
            sigControls.style.display = 'flex';
            sigControls.style.gap = '5px';

            const clearBtn = document.createElement('button');
            clearBtn.textContent = 'Clear';
            clearBtn.style.padding = '4px 8px';
            clearBtn.style.fontSize = '0.8rem';
            clearBtn.style.border = '1px solid #ddd';
            clearBtn.style.borderRadius = '4px';
            clearBtn.style.background = 'white';
            clearBtn.style.cursor = 'pointer';
            sigControls.appendChild(clearBtn);
            sigContainer.appendChild(sigControls);

            // Custom signature pad implementation
            const initCustomSignaturePad = () => {
                try {
                    // Wait for canvas to be ready
                    if (!sigCanvas.offsetWidth || !sigCanvas.offsetHeight) {
                        setTimeout(initCustomSignaturePad, 100);
                        return;
                    }

                    const rect = canvasWrapper.getBoundingClientRect();
                    const dpr = window.devicePixelRatio || 1;

                    // Set canvas size
                    sigCanvas.width = rect.width * dpr;
                    sigCanvas.height = rect.height * dpr;

                    const ctx = sigCanvas.getContext('2d');
                    ctx.scale(dpr, dpr);

                    // Set canvas background to white
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, rect.width, rect.height);
                    ctx.strokeStyle = '#000000';
                    ctx.lineWidth = 2;
                    ctx.lineCap = 'round';
                    ctx.lineJoin = 'round';

                    let isDrawing = false;
                    let lastX = 0;
                    let lastY = 0;

                    // Get coordinates relative to canvas
                    const getCoordinates = (e) => {
                        const rect = sigCanvas.getBoundingClientRect();
                        const scaleX = sigCanvas.width / rect.width;
                        const scaleY = sigCanvas.height / rect.height;

                        let clientX, clientY;
                        if (e.touches && e.touches.length > 0) {
                            clientX = e.touches[0].clientX;
                            clientY = e.touches[0].clientY;
                        } else {
                            clientX = e.clientX;
                            clientY = e.clientY;
                        }

                        return {
                            x: (clientX - rect.left) * scaleX / dpr,
                            y: (clientY - rect.top) * scaleY / dpr
                        };
                    };

                    // Start drawing
                    const startDrawing = (e) => {
                        e.preventDefault();
                        isDrawing = true;
                        const coords = getCoordinates(e);
                        lastX = coords.x;
                        lastY = coords.y;
                    };

                    // Draw
                    const draw = (e) => {
                        if (!isDrawing) return;
                        e.preventDefault();

                        const coords = getCoordinates(e);

                        ctx.beginPath();
                        ctx.moveTo(lastX, lastY);
                        ctx.lineTo(coords.x, coords.y);
                        ctx.stroke();

                        lastX = coords.x;
                        lastY = coords.y;

                        // Save signature data
                        formData[fieldId] = sigCanvas.toDataURL('image/png');
                    };

                    // Stop drawing
                    const stopDrawing = (e) => {
                        if (isDrawing) {
                            e.preventDefault();
                            isDrawing = false;
                            formData[fieldId] = sigCanvas.toDataURL('image/png');
                        }
                    };

                    // Mouse events
                    sigCanvas.addEventListener('mousedown', startDrawing);
                    sigCanvas.addEventListener('mousemove', draw);
                    sigCanvas.addEventListener('mouseup', stopDrawing);
                    sigCanvas.addEventListener('mouseout', stopDrawing);

                    // Touch events
                    sigCanvas.addEventListener('touchstart', startDrawing);
                    sigCanvas.addEventListener('touchmove', draw);
                    sigCanvas.addEventListener('touchend', stopDrawing);
                    sigCanvas.addEventListener('touchcancel', stopDrawing);

                    // Clear button
                    clearBtn.onclick = () => {
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, rect.width, rect.height);
                        formData[fieldId] = '';
                    };

                    // Restore saved signature if it exists
                    if (formData[fieldId]) {
                        const img = new Image();
                        img.onload = () => {
                            ctx.drawImage(img, 0, 0, rect.width, rect.height);
                        };
                        img.src = formData[fieldId];
                    }

                    // Store canvas context for cleanup if needed
                    signaturePads[fieldId] = {
                        clear: () => {
                            ctx.fillStyle = '#ffffff';
                            ctx.fillRect(0, 0, rect.width, rect.height);
                            formData[fieldId] = '';
                        },
                        canvas: sigCanvas,
                        ctx: ctx
                    };

                    console.log('Custom signature pad initialized for field:', fieldId);
                } catch (error) {
                    console.error('Error initializing signature pad:', error);
                    canvasWrapper.style.background = '#f0f0f0';
                    canvasWrapper.style.display = 'flex';
                    canvasWrapper.style.alignItems = 'center';
                    canvasWrapper.style.justifyContent = 'center';
                    canvasWrapper.textContent = 'Error loading signature pad';
                }
            };

            setTimeout(initCustomSignaturePad, 200);

            return sigContainer;

        case 'textarea':
            const textarea = document.createElement('textarea');
            textarea.className = 'form-field-input';
            textarea.placeholder = field.placeholder || '';
            textarea.required = field.required || false;
            textarea.style.resize = 'none';
            textarea.style.height = '100%';
            textarea.value = formData[fieldId] || '';
            textarea.onchange = () => formData[fieldId] = textarea.value;
            return textarea;

        case 'dropdown':
            const select = document.createElement('select');
            select.className = 'form-field-input';
            select.required = field.required || false;

            const defaultOption = document.createElement('option');
            defaultOption.value = '';
            defaultOption.textContent = '-- Select --';
            select.appendChild(defaultOption);

            if (field.options) {
                field.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.value = opt;
                    option.textContent = opt;
                    if (formData[fieldId] === opt) {
                        option.selected = true;
                    }
                    select.appendChild(option);
                });
            }

            select.onchange = () => formData[fieldId] = select.value;
            return select;

        case 'checkbox':
            const checkboxContainer = document.createElement('div');
            checkboxContainer.style.display = 'flex';
            checkboxContainer.style.alignItems = 'center';
            checkboxContainer.style.height = '100%';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.required = field.required || false;
            checkbox.checked = formData[fieldId] === 'true' || formData[fieldId] === true;
            checkbox.onchange = () => formData[fieldId] = checkbox.checked;
            checkboxContainer.appendChild(checkbox);

            const checkboxLabel = document.createElement('label');
            checkboxLabel.textContent = field.label || 'Check';
            checkboxLabel.style.marginLeft = '8px';
            checkboxContainer.appendChild(checkboxLabel);

            return checkboxContainer;

        default:
            const defaultInput = document.createElement('input');
            defaultInput.type = 'text';
            defaultInput.className = 'form-field-input';
            return defaultInput;
    }
}

// Save data
function saveData() {
    // Validate required fields
    const errors = [];
    formConfig.fields.forEach(field => {
        if (field.required) {
            const value = formData[field.id];
            if (!value || value === '' || value === null || value === undefined) {
                errors.push(field.label || field.id);
            }
        }
    });

    if (errors.length > 0) {
        alert('Please fill in all required fields:\n- ' + errors.join('\n- '));
        return;
    }

    // Prepare data to save
    const dataToSave = {
        formId: formConfig.id,
        formName: formConfig.name,
        pdfFile: formConfig.pdfFile,
        data: formData,
        savedAt: new Date().toISOString()
    };

    // Save via AJAX
    fetch('includes/save-data.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(dataToSave)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            alert('Data saved successfully!');
            // Optionally redirect or clear form
        } else {
            alert('Error saving data: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('Error saving data');
    });
}

// Show error message
function showError(message) {
    const errorDiv = document.getElementById('errorMessage');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}
