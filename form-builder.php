<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Form Builder - PDF Data Labels</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f5f5;
            height: 100vh;
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
            z-index: 1000;
        }

        .header h1 {
            font-size: 1.3rem;
        }

        .header-actions {
            display: flex;
            gap: 10px;
        }

        .btn {
            padding: 8px 16px;
            border: none;
            border-radius: 6px;
            cursor: pointer;
            font-size: 0.9rem;
            transition: all 0.3s ease;
            text-decoration: none;
            display: inline-block;
        }

        .btn-primary {
            background: rgba(255, 255, 255, 0.2);
            color: white;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .btn-primary:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .btn-success {
            background: #28a745;
            color: white;
        }

        .btn-success:hover {
            background: #218838;
        }

        .main-container {
            display: flex;
            height: calc(100vh - 60px);
        }

        .components-panel {
            width: 280px;
            background: white;
            border-right: 1px solid #ddd;
            padding: 20px;
            overflow-y: auto;
            box-shadow: 2px 0 10px rgba(0, 0, 0, 0.05);
        }

        .components-panel h2 {
            font-size: 1.1rem;
            margin-bottom: 15px;
            color: #333;
        }

        .component-item {
            background: #f8f9fa;
            border: 2px dashed #667eea;
            border-radius: 8px;
            padding: 15px;
            margin-bottom: 10px;
            cursor: grab;
            transition: all 0.3s ease;
            text-align: center;
        }

        .component-item:hover {
            background: #e8e8ff;
            border-color: #764ba2;
            transform: translateY(-2px);
        }

        .component-item:active {
            cursor: grabbing;
        }

        .component-icon {
            font-size: 2rem;
            margin-bottom: 8px;
        }

        .component-name {
            font-weight: 500;
            color: #333;
            font-size: 0.9rem;
        }

        .canvas-container {
            flex: 1;
            position: relative;
            overflow: auto;
            background: #e0e0e0;
            display: flex;
            justify-content: center;
            align-items: flex-start;
            padding: 20px;
        }

        .pdf-canvas-wrapper {
            position: relative;
            background: white;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
            margin: 20px auto;
        }

        #pdf-canvas {
            display: block;
        }

        .overlay-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: auto;
        }

        .overlay-layer.drag-over {
            background: rgba(102, 126, 234, 0.05);
        }

        .pdf-pagination {
            position: absolute;
            bottom: -50px;
            left: 50%;
            transform: translateX(-50%);
            display: flex;
            align-items: center;
            gap: 10px;
            background: white;
            padding: 10px 20px;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .pdf-pagination button {
            padding: 8px 16px;
            border: 1px solid #667eea;
            background: white;
            color: #667eea;
            border-radius: 4px;
            cursor: pointer;
            font-size: 0.9rem;
        }

        .pdf-pagination button:hover:not(:disabled) {
            background: #667eea;
            color: white;
        }

        .pdf-pagination button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
        }

        .pdf-pagination span {
            padding: 0 10px;
            font-weight: 500;
            color: #333;
        }

        .form-field {
            position: absolute;
            border: 2px solid #667eea;
            background: rgba(102, 126, 234, 0.1);
            cursor: move;
            pointer-events: all;
            min-width: 150px;
            min-height: 30px;
            border-radius: 4px;
        }

        .form-field.selected {
            border-color: #764ba2;
            background: rgba(118, 75, 162, 0.2);
            box-shadow: 0 0 0 3px rgba(118, 75, 162, 0.3);
        }

        .form-field-label {
            padding: 4px 8px;
            font-size: 0.75rem;
            color: #667eea;
            font-weight: 600;
            background: rgba(255, 255, 255, 0.9);
            border-radius: 4px 4px 0 0;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .form-field-input {
            width: 100%;
            height: calc(100% - 24px);
            border: none;
            background: transparent;
            padding: 4px;
            font-size: 0.85rem;
            pointer-events: none;
        }

        .form-field-resize {
            position: absolute;
            bottom: 0;
            right: 0;
            width: 12px;
            height: 12px;
            background: #667eea;
            cursor: nwse-resize;
            border-radius: 4px 0 4px 0;
        }

        .form-field-delete {
            position: absolute;
            top: -8px;
            right: -8px;
            width: 20px;
            height: 20px;
            background: #dc3545;
            color: white;
            border: none;
            border-radius: 50%;
            cursor: pointer;
            font-size: 12px;
            display: none;
            align-items: center;
            justify-content: center;
        }

        .form-field.selected .form-field-delete {
            display: flex;
        }

        .properties-panel {
            width: 320px;
            background: white;
            border-left: 1px solid #ddd;
            padding: 20px;
            overflow-y: auto;
            box-shadow: -2px 0 10px rgba(0, 0, 0, 0.05);
        }

        .properties-panel h2 {
            font-size: 1.1rem;
            margin-bottom: 15px;
            color: #333;
        }

        .form-group {
            margin-bottom: 15px;
        }

        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #555;
            font-size: 0.9rem;
        }

        .form-group input,
        .form-group select,
        .form-group textarea {
            width: 100%;
            padding: 8px;
            border: 1px solid #ddd;
            border-radius: 4px;
            font-size: 0.9rem;
        }

        .form-group textarea {
            resize: vertical;
            min-height: 60px;
        }

        .empty-state {
            text-align: center;
            padding: 40px 20px;
            color: #999;
        }

        .empty-state p {
            margin-top: 10px;
        }

        .unit-input-group {
            display: flex;
            gap: 5px;
        }

        .unit-input-group input {
            flex: 1;
        }

        .unit-input-group select {
            width: 100px;
        }

        .save-form-modal {
            display: none;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 2000;
            align-items: center;
            justify-content: center;
        }

        .save-form-modal.active {
            display: flex;
        }

        .modal-content {
            background: white;
            padding: 30px;
            border-radius: 8px;
            max-width: 500px;
            width: 90%;
            max-height: 90vh;
            overflow-y: auto;
        }

        .modal-content h3 {
            margin-bottom: 20px;
        }

        .modal-close {
            position: absolute;
            top: 15px;
            right: 15px;
            background: none;
            border: none;
            font-size: 24px;
            cursor: pointer;
            color: #999;
            width: 30px;
            height: 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 50%;
            transition: all 0.3s ease;
        }

        .modal-close:hover {
            background: #f0f0f0;
            color: #333;
        }

        .existing-forms {
            margin-bottom: 20px;
            padding: 15px;
            background: #f8f9fa;
            border-radius: 6px;
        }

        .existing-forms h4 {
            margin-bottom: 10px;
            font-size: 0.9rem;
            color: #666;
        }

        .form-option {
            padding: 10px;
            margin: 5px 0;
            border: 2px solid #ddd;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.3s ease;
            background: white;
        }

        .form-option:hover {
            border-color: #667eea;
            background: #f0f0ff;
        }

        .form-option.selected {
            border-color: #667eea;
            background: #e8e8ff;
        }

        .form-option-name {
            font-weight: 500;
            color: #333;
            margin-bottom: 3px;
        }

        .form-option-meta {
            font-size: 0.8rem;
            color: #666;
        }

        .new-form-option {
            padding: 10px;
            margin: 5px 0;
            border: 2px dashed #667eea;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.3s ease;
            background: white;
            text-align: center;
            color: #667eea;
            font-weight: 500;
        }

        .new-form-option:hover {
            background: #f0f0ff;
        }

        .new-form-option.selected {
            background: #e8e8ff;
            border-style: solid;
        }

        .version-options {
            margin-top: 15px;
            padding: 15px;
            background: #fff3cd;
            border-radius: 6px;
            border: 1px solid #ffc107;
        }

        .version-options h4 {
            font-size: 0.9rem;
            margin-bottom: 10px;
            color: #856404;
        }

        .version-option {
            display: flex;
            align-items: center;
            gap: 10px;
            margin: 8px 0;
        }

        .version-option input[type="radio"] {
            margin: 0;
        }

        .version-option label {
            cursor: pointer;
            font-size: 0.9rem;
            color: #333;
        }

        .version-option-desc {
            font-size: 0.8rem;
            color: #666;
            margin-left: 25px;
        }

        .modal-actions {
            display: flex;
            gap: 10px;
            margin-top: 20px;
        }

        .modal-actions .btn {
            flex: 1;
        }

        .btn-cancel {
            background: #6c757d;
            color: white;
        }

        .btn-cancel:hover {
            background: #5a6268;
        }

        .form-selection-modal {
            display: flex;
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.5);
            z-index: 3000;
            align-items: center;
            justify-content: center;
        }

        .form-selection-modal.hidden {
            display: none;
        }

        .form-selection-content {
            background: white;
            padding: 40px;
            border-radius: 12px;
            max-width: 600px;
            width: 90%;
            max-height: 90vh;
            overflow-y: auto;
            box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
        }

        .form-selection-content h2 {
            margin-bottom: 20px;
            color: #333;
        }

        .form-selection-content p {
            color: #666;
            margin-bottom: 30px;
        }

        .selection-options {
            display: flex;
            flex-direction: column;
            gap: 15px;
        }

        .selection-option {
            border: 2px solid #ddd;
            border-radius: 8px;
            padding: 20px;
            cursor: pointer;
            transition: all 0.3s ease;
            background: white;
        }

        .selection-option:hover {
            border-color: #667eea;
            background: #f8f9ff;
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .selection-option.selected {
            border-color: #667eea;
            background: #e8e8ff;
        }

        .selection-option h3 {
            color: #333;
            margin-bottom: 8px;
            font-size: 1.1rem;
        }

        .selection-option p {
            color: #666;
            font-size: 0.9rem;
            margin: 0;
        }

        .existing-forms-list {
            margin-top: 20px;
            max-height: 300px;
            overflow-y: auto;
        }

        .existing-form-item {
            border: 1px solid #ddd;
            border-radius: 6px;
            padding: 15px;
            margin: 10px 0;
            cursor: pointer;
            transition: all 0.2s ease;
            background: white;
        }

        .existing-form-item:hover {
            border-color: #667eea;
            background: #f8f9ff;
        }

        .existing-form-item.selected {
            border-color: #667eea;
            background: #e8e8ff;
            border-width: 2px;
        }

        .existing-form-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 8px;
        }

        .existing-form-name {
            font-weight: 600;
            color: #333;
        }

        .version-badge-small {
            display: inline-block;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 0.75rem;
            font-weight: 600;
            margin-left: 8px;
        }

        .version-badge-small.latest {
            background: #28a745;
            color: white;
        }

        .version-badge-small.older {
            background: #6c757d;
            color: white;
        }

        .existing-form-meta {
            font-size: 0.85rem;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📋 Form Builder</h1>
        <div class="header-actions">
            <button class="btn btn-success" onclick="saveForm()">Save Form</button>
            <a href="index.php" class="btn btn-primary">← Back</a>
        </div>
    </div>

    <div class="main-container">
        <div class="components-panel">
            <h2>📦 Components</h2>
            <div class="component-item" draggable="true" data-type="text">
                <div class="component-icon">📝</div>
                <div class="component-name">Text Entry</div>
            </div>
            <div class="component-item" draggable="true" data-type="date">
                <div class="component-icon">📅</div>
                <div class="component-name">Date Entry</div>
            </div>
            <div class="component-item" draggable="true" data-type="number">
                <div class="component-icon">🔢</div>
                <div class="component-name">Number Entry</div>
            </div>
            <div class="component-item" draggable="true" data-type="signature">
                <div class="component-icon">✍️</div>
                <div class="component-name">Signature</div>
            </div>
            <div class="component-item" draggable="true" data-type="textarea">
                <div class="component-icon">📄</div>
                <div class="component-name">Text Area</div>
            </div>
            <div class="component-item" draggable="true" data-type="dropdown">
                <div class="component-icon">📋</div>
                <div class="component-name">Dropdown</div>
            </div>
            <div class="component-item" draggable="true" data-type="checkbox">
                <div class="component-icon">☑️</div>
                <div class="component-name">Checkbox</div>
            </div>
        </div>

        <div class="canvas-container" id="canvasContainer">
            <div class="pdf-canvas-wrapper" id="pdfWrapper">
                <canvas id="pdf-canvas"></canvas>
                <div class="overlay-layer" id="overlayLayer"></div>
                <div class="pdf-pagination" id="pdfPagination" style="display: none;">
                    <button id="prevPage" onclick="changePage(-1)">← Previous</button>
                    <span id="pageInfo">Page 1 of 1</span>
                    <button id="nextPage" onclick="changePage(1)">Next →</button>
                </div>
            </div>
        </div>

        <div class="properties-panel">
            <h2>⚙️ Properties</h2>
            <div id="propertiesContent">
                <div class="empty-state">
                    <p>Select a field to edit its properties</p>
                </div>
            </div>
        </div>
    </div>

    <div class="save-form-modal" id="saveModal" onclick="handleModalBackdropClick(event)">
        <div class="modal-content" onclick="event.stopPropagation()">
            <button class="modal-close" onclick="closeSaveModal()" title="Close">×</button>
            <h3>Save Form Configuration</h3>

            <div class="existing-forms" id="existingForms" style="display: none;">
                <h4>Update Existing Form:</h4>
                <div id="existingFormsList"></div>
                <div class="new-form-option" id="newFormOption" onclick="selectFormOption(null)">
                    + Create New Form
                </div>
            </div>

            <div class="form-group">
                <label>Form Name:</label>
                <input type="text" id="formName" placeholder="Enter form name" required>
            </div>
            <div class="form-group">
                <label>Description (optional):</label>
                <textarea id="formDescription" placeholder="Enter description"></textarea>
            </div>
            <input type="hidden" id="selectedFormId" value="">
            <div class="version-options" id="versionOptions" style="display: none;">
                <h4>Save Options:</h4>
                <div class="version-option">
                    <input type="radio" id="saveOptionUpdate" name="saveOption" value="update" checked>
                    <label for="saveOptionUpdate">Update existing version</label>
                </div>
                <div class="version-option-desc">Modify the current version (keeps same version number)</div>
                <div class="version-option">
                    <input type="radio" id="saveOptionNewVersion" name="saveOption" value="newVersion">
                    <label for="saveOptionNewVersion">Create new version</label>
                </div>
                <div class="version-option-desc">Create a new version (increments version number, keeps old version)</div>
            </div>
            <div class="modal-actions">
                <button class="btn btn-success" onclick="confirmSave()">Save</button>
                <button class="btn btn-cancel" onclick="closeSaveModal()">Cancel</button>
            </div>
        </div>
    </div>

    <!-- Form Selection Modal -->
    <div class="form-selection-modal" id="formSelectionModal">
        <div class="form-selection-content">
            <h2>📋 Start Form Builder</h2>
            <p>Choose how you want to start building your form:</p>

            <div class="selection-options">
                <div class="selection-option" id="optionNew" onclick="selectOption('new')">
                    <h3>✨ Start New Form</h3>
                    <p>Create a completely new form from scratch</p>
                </div>
                <div class="selection-option" id="optionExisting" onclick="selectOption('existing')">
                    <h3>📂 Load Existing Form</h3>
                    <p>Continue editing an existing form or version</p>
                </div>
            </div>

            <div class="existing-forms-list" id="selectionFormsList" style="display: none;">
                <h3 style="margin-bottom: 15px; font-size: 1rem;">Select a form to load:</h3>
                <div id="formsListContainer">
                    <p style="color: #999; text-align: center; padding: 20px;">Loading forms...</p>
                </div>
            </div>

            <div style="display: flex; gap: 10px; margin-top: 30px;">
                <button class="btn btn-success" id="confirmBtn" onclick="confirmSelection()" style="flex: 1;" disabled>Continue</button>
                <a href="index.php" class="btn btn-cancel" style="flex: 1; text-align: center;">Cancel</a>
            </div>
        </div>
    </div>

    <script src="js/form-builder.js"></script>
    <script>
        // Form selection state
        let selectedOption = null;
        let selectedFormId = null;
        let availableForms = [];
        const pdfFile = '<?php echo isset($_GET["file"]) ? htmlspecialchars($_GET["file"]) : ""; ?>';

        if (!pdfFile) {
            document.getElementById('canvasContainer').innerHTML = '<div class="empty-state"><p>No PDF file specified. Please select a PDF from the main page.</p></div>';
            document.getElementById('formSelectionModal').classList.add('hidden');
        } else {
            // Load available forms for this PDF
            loadAvailableForms();
        }

        function loadAvailableForms() {
            fetch('includes/list-forms.php')
                .then(response => response.json())
                .then(data => {
                    console.log('Forms loaded:', data); // Debug
                    if (data.success && data.forms) {
                        availableForms = data.forms.filter(form => form.pdfFile === pdfFile);
                        console.log('Filtered forms for PDF:', pdfFile, availableForms); // Debug

                        if (availableForms.length > 0) {
                            // Store forms but don't display yet - will display when option is selected
                            displayExistingForms(availableForms);
                        } else {
                            // No existing forms, hide the existing option
                            document.getElementById('optionExisting').style.display = 'none';
                        }
                    } else {
                        console.log('No forms found or error in response');
                        document.getElementById('optionExisting').style.display = 'none';
                    }
                })
                .catch(error => {
                    console.error('Error loading forms:', error);
                    document.getElementById('optionExisting').style.display = 'none';
                });
        }

        function displayExistingForms(forms) {
            const container = document.getElementById('formsListContainer');
            if (!container) {
                console.error('formsListContainer not found');
                return;
            }

            container.innerHTML = '';

            if (!forms || forms.length === 0) {
                container.innerHTML = '<p style="color: #999; text-align: center; padding: 20px;">No forms found for this PDF.</p>';
                return;
            }

            // Group forms by name
            const grouped = {};
            forms.forEach(form => {
                const key = form.name;
                if (!grouped[key]) {
                    grouped[key] = [];
                }
                grouped[key].push(form);
            });

            Object.keys(grouped).forEach(formName => {
                const versions = grouped[formName].sort((a, b) => (b.version || 1) - (a.version || 1));

                versions.forEach(form => {
                    const isLatest = form.isLatest || form.version === versions[0].version;
                    const item = document.createElement('div');
                    item.className = 'existing-form-item';
                    item.setAttribute('data-form-id', form.id);
                    item.onclick = function() {
                        selectExistingForm(form.id);
                    };
                    item.innerHTML = `
                        <div class="existing-form-header">
                            <div class="existing-form-name">
                                ${escapeHtml(form.name)}
                                <span class="version-badge-small ${isLatest ? 'latest' : 'older'}">
                                    v${form.version || 1}${isLatest ? ' - LATEST' : ''}
                                </span>
                            </div>
                        </div>
                        <div class="existing-form-meta">
                            ${form.fieldCount || 0} fields • Updated: ${formatDate(form.updatedAt)}
                        </div>
                    `;
                    container.appendChild(item);
                });
            });

            console.log('Displayed forms:', container.children.length);
        }

        function selectOption(option) {
            selectedOption = option;
            selectedFormId = null;

            // Update UI
            document.querySelectorAll('.selection-option').forEach(el => {
                el.classList.remove('selected');
            });
            const optionElement = document.getElementById('option' + option.charAt(0).toUpperCase() + option.slice(1));
            if (optionElement) {
                optionElement.classList.add('selected');
            }

            // Show/hide forms list
            const formsList = document.getElementById('selectionFormsList');
            if (option === 'existing') {
                if (formsList) {
                    formsList.style.display = 'block';
                    // Re-display forms if they exist
                    if (availableForms && availableForms.length > 0) {
                        displayExistingForms(availableForms);
                    } else {
                        // Try loading again
                        loadAvailableForms();
                    }
                }
            } else {
                if (formsList) {
                    formsList.style.display = 'none';
                }
                document.querySelectorAll('.existing-form-item').forEach(el => {
                    el.classList.remove('selected');
                });
            }

            // Enable/disable confirm button
            const confirmBtn = document.getElementById('confirmBtn');
            if (option === 'new') {
                if (confirmBtn) confirmBtn.disabled = false;
            } else {
                if (confirmBtn) confirmBtn.disabled = selectedFormId === null;
            }
        }

        function selectExistingForm(formId) {
            selectedFormId = formId;

            // Update UI
            document.querySelectorAll('.existing-form-item').forEach(el => {
                el.classList.remove('selected');
            });
            document.querySelector(`[data-form-id="${formId}"]`).classList.add('selected');

            // Enable confirm button
            document.getElementById('confirmBtn').disabled = false;
        }

        function confirmSelection() {
            if (selectedOption === 'new') {
                // Start new form
                document.getElementById('formSelectionModal').classList.add('hidden');
                initFormBuilder(pdfFile, null); // null = don't load existing form
            } else if (selectedOption === 'existing' && selectedFormId) {
                // Load existing form
                document.getElementById('formSelectionModal').classList.add('hidden');
                initFormBuilder(pdfFile, selectedFormId);
            }
        }

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function formatDate(dateString) {
            if (!dateString) return 'Unknown';
            const date = new Date(dateString);
            return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        }
    </script>
</body>
</html>
