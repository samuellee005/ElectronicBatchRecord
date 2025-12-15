// Form Builder JavaScript
let pdfDoc = null;
let currentPage = 1;
let totalPages = 1;
let scale = 1.5;
let formFields = [];
let selectedField = null;
let isDragging = false;
let dragOffset = { x: 0, y: 0 };
let isResizing = false;
let resizeStart = { x: 0, y: 0, width: 0, height: 0 };

// Initialize PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Initialize form builder
async function initFormBuilder(pdfFileName, formIdToLoad = null) {
    try {
        const pdfPath = `uploads/${pdfFileName}`;
        const loadingTask = pdfjsLib.getDocument(pdfPath);
        pdfDoc = await loadingTask.promise;
        totalPages = pdfDoc.numPages;

        await renderPage(1);
        updatePaginationControls();
        setupDragAndDrop();

        // Load form configuration only if formId is provided, or auto-load latest if null
        if (formIdToLoad === null) {
            // Don't auto-load - user chose to start new
            formFields = [];
        } else if (formIdToLoad) {
            // Load specific form by ID
            await loadFormById(formIdToLoad);
        } else {
            // Auto-load latest form (backward compatibility)
            loadFormConfiguration(pdfFileName);
        }
    } catch (error) {
        console.error('Error loading PDF:', error);
        document.getElementById('canvasContainer').innerHTML =
            '<div class="empty-state"><p>Error loading PDF. Please make sure the file exists.</p></div>';
    }
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

// Setup drag and drop for components
function setupDragAndDrop() {
    const componentItems = document.querySelectorAll('.component-item');
    const overlayLayer = document.getElementById('overlayLayer');
    const canvasContainer = document.getElementById('canvasContainer');

    componentItems.forEach(item => {
        item.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('component-type', item.dataset.type);
            e.dataTransfer.effectAllowed = 'copy';
        });
    });

    // Allow drop on overlay layer
    overlayLayer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        overlayLayer.classList.add('drag-over');
    });

    overlayLayer.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlayLayer.classList.add('drag-over');
    });

    overlayLayer.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        // Only remove class if leaving the overlay layer itself
        if (e.target === overlayLayer) {
            overlayLayer.classList.remove('drag-over');
        }
    });

    overlayLayer.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        overlayLayer.classList.remove('drag-over');
        const componentType = e.dataTransfer.getData('component-type');
        if (componentType) {
            const rect = overlayLayer.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            addFormField(componentType, x, y);
        }
    });

    // Also allow drop on canvas container as fallback
    canvasContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    canvasContainer.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const componentType = e.dataTransfer.getData('component-type');
        if (componentType) {
            const overlayRect = overlayLayer.getBoundingClientRect();
            const x = e.clientX - overlayRect.left;
            const y = e.clientY - overlayRect.top;
            addFormField(componentType, x, y);
        }
    });
}

// Add form field
function addFormField(type, x, y) {
    const fieldId = 'field_' + Date.now();
    const defaultConfig = getDefaultFieldConfig(type);

    // Constrain coordinates to canvas bounds
    const canvas = document.getElementById('pdf-canvas');
    const maxX = canvas.width - defaultConfig.width;
    const maxY = canvas.height - defaultConfig.height;
    x = Math.max(0, Math.min(x, maxX));
    y = Math.max(0, Math.min(y, maxY));

    const field = {
        id: fieldId,
        type: type,
        page: currentPage, // Store which page this field is on
        x: x,
        y: y,
        width: defaultConfig.width,
        height: defaultConfig.height,
        label: defaultConfig.label,
        required: false,
        ...defaultConfig
    };

    formFields.push(field);
    renderFormFields();
    selectField(fieldId);
}

// Get default field configuration
function getDefaultFieldConfig(type) {
    const configs = {
        text: { width: 200, height: 35, label: 'Text Field', placeholder: 'Enter text' },
        date: { width: 200, height: 35, label: 'Date Field', placeholder: 'Select date' },
        number: { width: 200, height: 35, label: 'Number Field', placeholder: 'Enter number', unit: '' },
        signature: { width: 300, height: 100, label: 'Signature Field', placeholder: 'Sign here' },
        textarea: { width: 300, height: 100, label: 'Text Area', placeholder: 'Enter text' },
        dropdown: { width: 200, height: 35, label: 'Dropdown Field', options: ['Option 1', 'Option 2'] },
        checkbox: { width: 150, height: 30, label: 'Checkbox Field', checked: false }
    };

    return configs[type] || configs.text;
}

// Render all form fields
function renderFormFields() {
    const overlayLayer = document.getElementById('overlayLayer');
    overlayLayer.innerHTML = '';

    // Only show fields for the current page
    const currentPageFields = formFields.filter(field => field.page === currentPage);

    currentPageFields.forEach(field => {
        const fieldElement = createFieldElement(field);
        overlayLayer.appendChild(fieldElement);
    });
}

// Create field element
function createFieldElement(field) {
    const div = document.createElement('div');
    div.className = 'form-field' + (selectedField && selectedField.id === field.id ? ' selected' : '');
    div.id = field.id;
    div.style.left = field.x + 'px';
    div.style.top = field.y + 'px';
    div.style.width = field.width + 'px';
    div.style.height = field.height + 'px';

    const label = document.createElement('div');
    label.className = 'form-field-label';
    label.textContent = field.label || 'Field';
    div.appendChild(label);

    const input = createInputForField(field);
    div.appendChild(input);

    const resizeHandle = document.createElement('div');
    resizeHandle.className = 'form-field-resize';
    div.appendChild(resizeHandle);

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'form-field-delete';
    deleteBtn.innerHTML = '×';
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteField(field.id);
    };
    div.appendChild(deleteBtn);

    // Make field draggable
    makeFieldDraggable(div, field);
    makeFieldResizable(div, field);

    // Select field on click
    div.addEventListener('click', (e) => {
        e.stopPropagation();
        selectField(field.id);
    });

    return div;
}

// Create input element based on field type
function createInputForField(field) {
    const container = document.createElement('div');
    container.style.padding = '4px';
    container.style.height = 'calc(100% - 24px)';
    container.style.display = 'flex';
    container.style.alignItems = 'center';

    switch(field.type) {
        case 'text':
        case 'date':
            const input = document.createElement('input');
            input.type = field.type === 'date' ? 'date' : 'text';
            input.placeholder = field.placeholder || '';
            input.className = 'form-field-input';
            input.disabled = true;
            container.appendChild(input);
            break;

        case 'number':
            const numContainer = document.createElement('div');
            numContainer.className = 'unit-input-group';
            numContainer.style.width = '100%';
            const numInput = document.createElement('input');
            numInput.type = 'number';
            numInput.placeholder = field.placeholder || '';
            numInput.className = 'form-field-input';
            numInput.style.flex = '1';
            numInput.disabled = true;
            numContainer.appendChild(numInput);
            if (field.unit) {
                const unitSpan = document.createElement('span');
                unitSpan.textContent = field.unit;
                unitSpan.style.padding = '4px 8px';
                unitSpan.style.background = '#f0f0f0';
                unitSpan.style.borderRadius = '4px';
                numContainer.appendChild(unitSpan);
            }
            container.appendChild(numContainer);
            break;

        case 'signature':
            const sigDiv = document.createElement('div');
            sigDiv.className = 'form-field-input';
            sigDiv.style.border = '1px dashed #ccc';
            sigDiv.style.borderRadius = '4px';
            sigDiv.style.display = 'flex';
            sigDiv.style.alignItems = 'center';
            sigDiv.style.justifyContent = 'center';
            sigDiv.textContent = field.placeholder || 'Sign here';
            sigDiv.style.color = '#999';
            container.appendChild(sigDiv);
            break;

        case 'textarea':
            const textarea = document.createElement('textarea');
            textarea.placeholder = field.placeholder || '';
            textarea.className = 'form-field-input';
            textarea.disabled = true;
            textarea.style.resize = 'none';
            container.appendChild(textarea);
            break;

        case 'dropdown':
            const select = document.createElement('select');
            select.className = 'form-field-input';
            select.disabled = true;
            if (field.options) {
                field.options.forEach(opt => {
                    const option = document.createElement('option');
                    option.textContent = opt;
                    select.appendChild(option);
                });
            }
            container.appendChild(select);
            break;

        case 'checkbox':
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'form-field-input';
            checkbox.disabled = true;
            checkbox.checked = field.checked || false;
            container.appendChild(checkbox);
            break;
    }

    return container;
}

// Make field draggable
function makeFieldDraggable(element, field) {
    let dragStartHandler = (e) => {
        // Don't start drag if clicking on resize handle or delete button
        if (e.target.classList.contains('form-field-resize') ||
            e.target.classList.contains('form-field-delete') ||
            e.target.closest('.form-field-delete')) {
            return;
        }

        // Don't start drag if clicking on input elements
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
            return;
        }

        e.preventDefault();
        isDragging = true;
        const rect = element.getBoundingClientRect();
        const overlayRect = document.getElementById('overlayLayer').getBoundingClientRect();
        dragOffset.x = e.clientX - rect.left;
        dragOffset.y = e.clientY - rect.top;

        selectField(field.id);
        element.style.cursor = 'grabbing';
    };

    element.addEventListener('mousedown', dragStartHandler);

    let mouseMoveHandler = (e) => {
        if (!isDragging || selectedField?.id !== field.id) return;

        e.preventDefault();
        const overlayLayer = document.getElementById('overlayLayer');
        const overlayRect = overlayLayer.getBoundingClientRect();
        const canvas = document.getElementById('pdf-canvas');

        let x = e.clientX - overlayRect.left - dragOffset.x;
        let y = e.clientY - overlayRect.top - dragOffset.y;

        // Constrain to canvas bounds
        x = Math.max(0, Math.min(x, canvas.width - field.width));
        y = Math.max(0, Math.min(y, canvas.height - field.height));

        field.x = x;
        field.y = y;
        element.style.left = x + 'px';
        element.style.top = y + 'px';
    };

    document.addEventListener('mousemove', mouseMoveHandler);

    let mouseUpHandler = () => {
        if (isDragging && selectedField?.id === field.id) {
            isDragging = false;
            element.style.cursor = 'move';
        }
    };

    document.addEventListener('mouseup', mouseUpHandler);
}

// Make field resizable
function makeFieldResizable(element, field) {
    const resizeHandle = element.querySelector('.form-field-resize');

    resizeHandle.addEventListener('mousedown', (e) => {
        e.stopPropagation();
        isResizing = true;
        resizeStart.x = e.clientX;
        resizeStart.y = e.clientY;
        resizeStart.width = field.width;
        resizeStart.height = field.height;
    });

    document.addEventListener('mousemove', (e) => {
        if (!isResizing || selectedField?.id !== field.id) return;

        const deltaX = e.clientX - resizeStart.x;
        const deltaY = e.clientY - resizeStart.y;

        const newWidth = Math.max(100, resizeStart.width + deltaX);
        const newHeight = Math.max(30, resizeStart.height + deltaY);

        const canvasRect = document.getElementById('pdf-canvas').getBoundingClientRect();
        const maxWidth = canvasRect.width - field.x;
        const maxHeight = canvasRect.height - field.y;

        field.width = Math.min(newWidth, maxWidth);
        field.height = Math.min(newHeight, maxHeight);

        element.style.width = field.width + 'px';
        element.style.height = field.height + 'px';
    });

    document.addEventListener('mouseup', () => {
        isResizing = false;
    });
}

// Select field
function selectField(fieldId) {
    selectedField = formFields.find(f => f.id === fieldId);
    renderFormFields();
    renderProperties();

    // Deselect on canvas click
    document.getElementById('overlayLayer').addEventListener('click', function deselect(e) {
        if (e.target === this) {
            selectedField = null;
            renderFormFields();
            renderProperties();
            this.removeEventListener('click', deselect);
        }
    }, { once: true });
}

// Delete field
function deleteField(fieldId) {
    formFields = formFields.filter(f => f.id !== fieldId);
    if (selectedField && selectedField.id === fieldId) {
        selectedField = null;
        renderProperties();
    }
    renderFormFields();
}

// Render properties panel
function renderProperties() {
    const propertiesContent = document.getElementById('propertiesContent');

    if (!selectedField) {
        propertiesContent.innerHTML = '<div class="empty-state"><p>Select a field to edit its properties</p></div>';
        return;
    }

    const field = selectedField;
    let html = `
        <div class="form-group">
            <label>Data Label (Field Name):</label>
            <input type="text" id="prop-label" value="${escapeHtml(field.label)}"
                   onchange="updateFieldProperty('label', this.value)">
        </div>
        <div class="form-group">
            <label>X Position:</label>
            <input type="number" id="prop-x" value="${field.x}"
                   onchange="updateFieldProperty('x', parseInt(this.value))">
        </div>
        <div class="form-group">
            <label>Y Position:</label>
            <input type="number" id="prop-y" value="${field.y}"
                   onchange="updateFieldProperty('y', parseInt(this.value))">
        </div>
        <div class="form-group">
            <label>Width:</label>
            <input type="number" id="prop-width" value="${field.width}"
                   onchange="updateFieldProperty('width', parseInt(this.value))">
        </div>
        <div class="form-group">
            <label>Height:</label>
            <input type="number" id="prop-height" value="${field.height}"
                   onchange="updateFieldProperty('height', parseInt(this.value))">
        </div>
        <div class="form-group">
            <label>
                <input type="checkbox" ${field.required ? 'checked' : ''}
                       onchange="updateFieldProperty('required', this.checked)">
                Required Field
            </label>
        </div>
    `;

    // Page number (read-only display)
    html += `
        <div class="form-group">
            <label>Page:</label>
            <input type="number" value="${field.page || currentPage}"
                   disabled style="background: #f0f0f0;">
            <small style="color: #666; display: block; margin-top: 5px;">
                Field is on page ${field.page || currentPage}
            </small>
        </div>
    `;

    // Type-specific properties
    if (field.type === 'text' || field.type === 'textarea') {
        html += `
            <div class="form-group">
                <label>Placeholder:</label>
                <input type="text" value="${escapeHtml(field.placeholder || '')}"
                       onchange="updateFieldProperty('placeholder', this.value)">
            </div>
        `;
    }

    if (field.type === 'number') {
        html += `
            <div class="form-group">
                <label>Unit of Measurement:</label>
                <select onchange="updateFieldProperty('unit', this.value)">
                    <option value="">None</option>
                    <option value="kg" ${field.unit === 'kg' ? 'selected' : ''}>kg</option>
                    <option value="g" ${field.unit === 'g' ? 'selected' : ''}>g</option>
                    <option value="mg" ${field.unit === 'mg' ? 'selected' : ''}>mg</option>
                    <option value="L" ${field.unit === 'L' ? 'selected' : ''}>L</option>
                    <option value="mL" ${field.unit === 'mL' ? 'selected' : ''}>mL</option>
                    <option value="°C" ${field.unit === '°C' ? 'selected' : ''}>°C</option>
                    <option value="°F" ${field.unit === '°F' ? 'selected' : ''}>°F</option>
                    <option value="%" ${field.unit === '%' ? 'selected' : ''}>%</option>
                    <option value="ppm" ${field.unit === 'ppm' ? 'selected' : ''}>ppm</option>
                    <option value="pH" ${field.unit === 'pH' ? 'selected' : ''}>pH</option>
                </select>
            </div>
        `;
    }

    if (field.type === 'dropdown') {
        html += `
            <div class="form-group">
                <label>Options (one per line):</label>
                <textarea onchange="updateDropdownOptions(this.value)">${(field.options || []).join('\n')}</textarea>
            </div>
        `;
    }

    propertiesContent.innerHTML = html;
}

// Update field property
function updateFieldProperty(prop, value) {
    if (!selectedField) return;

    selectedField[prop] = value;
    renderFormFields();
    renderProperties();
}

// Update dropdown options
function updateDropdownOptions(value) {
    if (!selectedField || selectedField.type !== 'dropdown') return;
    selectedField.options = value.split('\n').filter(opt => opt.trim());
    renderFormFields();
}

// Escape HTML
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Save form configuration
let existingFormsList = [];

function saveForm() {
    const modal = document.getElementById('saveModal');
    modal.classList.add('active');

    // Load existing forms for this PDF
    const pdfFile = new URLSearchParams(window.location.search).get('file');
    loadExistingForms(pdfFile);
}

function closeSaveModal() {
    const modal = document.getElementById('saveModal');
    modal.classList.remove('active');

    // Reset form
    document.getElementById('formName').value = '';
    document.getElementById('formDescription').value = '';
    document.getElementById('selectedFormId').value = '';
    document.getElementById('existingForms').style.display = 'none';
    document.getElementById('versionOptions').style.display = 'none';
    document.getElementById('saveOptionUpdate').checked = true;

    // Reset selected options
    document.querySelectorAll('.form-option, .new-form-option').forEach(el => {
        el.classList.remove('selected');
    });
}

function handleModalBackdropClick(event) {
    // Close modal if clicking on backdrop (not the content)
    if (event.target.id === 'saveModal') {
        closeSaveModal();
    }
}

function loadExistingForms(pdfFile) {
    fetch(`includes/list-forms.php`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.forms) {
                // Filter forms for this PDF
                existingFormsList = data.forms.filter(form => form.pdfFile === pdfFile);

                if (existingFormsList.length > 0) {
                    displayExistingForms(existingFormsList);
                } else {
                    document.getElementById('existingForms').style.display = 'none';
                }
            }
        })
        .catch(error => {
            console.error('Error loading forms:', error);
            document.getElementById('existingForms').style.display = 'none';
        });
}

function displayExistingForms(forms) {
    const container = document.getElementById('existingForms');
    const listDiv = document.getElementById('existingFormsList');
    const versionOptions = document.getElementById('versionOptions');

    container.style.display = 'block';
    listDiv.innerHTML = '';

    forms.forEach(form => {
        const formOption = document.createElement('div');
        formOption.className = 'form-option';
        formOption.setAttribute('data-form-id', form.id);
        formOption.onclick = function() {
            selectFormOption(form.id, form);
        };
        const versionText = form.version ? ` (v${form.version})` : '';
        const latestText = form.isLatest ? ' [LATEST]' : '';
        formOption.innerHTML = `
            <div class="form-option-name">${escapeHtml(form.name)}${versionText}${latestText}</div>
            <div class="form-option-meta">
                ${form.fieldCount} fields • Updated: ${formatDate(form.updatedAt)}
            </div>
        `;
        listDiv.appendChild(formOption);
    });

    // Show version options if a form is selected
    if (forms.length > 0) {
        versionOptions.style.display = 'block';
    }
}

function selectFormOption(formId, formData = null) {
    // Remove previous selections
    document.querySelectorAll('.form-option, .new-form-option').forEach(el => {
        el.classList.remove('selected');
    });

    // Set selected form ID
    document.getElementById('selectedFormId').value = formId || '';
    const versionOptions = document.getElementById('versionOptions');

    if (formId && formData) {
        // Update form with existing form data
        document.getElementById('formName').value = formData.name || '';
        document.getElementById('formDescription').value = formData.description || '';

        // Show version options for existing forms
        versionOptions.style.display = 'block';
        document.getElementById('saveOptionUpdate').checked = true;

        // Mark the selected option
        const options = document.querySelectorAll('.form-option');
        options.forEach(opt => {
            if (opt.getAttribute('data-form-id') === formId) {
                opt.classList.add('selected');
            }
        });
    } else {
        // New form - clear fields
        document.getElementById('formName').value = '';
        document.getElementById('formDescription').value = '';
        document.getElementById('newFormOption').classList.add('selected');
        versionOptions.style.display = 'none';
    }
}

function confirmSave() {
    const formName = document.getElementById('formName').value.trim();
    if (!formName) {
        alert('Please enter a form name');
        return;
    }

    const pdfFile = new URLSearchParams(window.location.search).get('file');
    const selectedFormId = document.getElementById('selectedFormId').value;
    const saveOption = document.querySelector('input[name="saveOption"]:checked')?.value || 'update';
    const createNewVersion = saveOption === 'newVersion' && selectedFormId;

    const formData = {
        name: formName,
        description: document.getElementById('formDescription').value.trim(),
        pdfFile: pdfFile,
        fields: formFields,
        formId: selectedFormId || null, // Include formId if updating
        createNewVersion: createNewVersion, // Flag to create new version
        createdAt: new Date().toISOString()
    };

    // Save via AJAX
    fetch('includes/save-form.php', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(formData)
    })
    .then(response => response.json())
    .then(data => {
        if (data.success) {
            const message = selectedFormId ? 'Form updated successfully!' : 'Form saved successfully!';
            alert(message);
            closeSaveModal();
        } else {
            alert('Error saving form: ' + data.message);
        }
    })
    .catch(error => {
        console.error('Error:', error);
        alert('Error saving form');
    });
}

function formatDate(dateString) {
    if (!dateString) return 'Unknown';
    const date = new Date(dateString);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
}

// Load form configuration by PDF (latest version)
function loadFormConfiguration(pdfFileName) {
    fetch(`includes/load-form.php?pdf=${encodeURIComponent(pdfFileName)}`)
        .then(response => response.json())
        .then(data => {
            if (data.success && data.form && data.form.fields) {
                // Ensure all fields have a page property (default to page 1 for old forms)
                formFields = data.form.fields.map(field => {
                    if (!field.page) {
                        field.page = 1;
                    }
                    return field;
                });
                renderFormFields();
            }
        })
        .catch(error => {
            console.error('Error loading form:', error);
        });
}

// Load form configuration by ID
async function loadFormById(formId) {
    try {
        const response = await fetch(`includes/load-form-by-id.php?id=${encodeURIComponent(formId)}`);
        const data = await response.json();

        if (data.success && data.form && data.form.fields) {
            // Ensure all fields have a page property (default to page 1 for old forms)
            formFields = data.form.fields.map(field => {
                if (!field.page) {
                    field.page = 1;
                }
                return field;
            });
            renderFormFields();
        }
    } catch (error) {
        console.error('Error loading form by ID:', error);
    }
}

// Close modal on Escape key
document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const modal = document.getElementById('saveModal');
        if (modal && modal.classList.contains('active')) {
            closeSaveModal();
        }
    }
});
