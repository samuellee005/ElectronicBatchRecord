<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Data Entry - Electronic Batch Record</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js"></script>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/signature_pad/4.0.9/signature_pad.min.js"></script>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 15px 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            display: flex;
            justify-content: space-between;
            align-items: center;
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

        .container {
            max-width: 1400px;
            margin: 20px auto;
            padding: 0 20px;
        }

        .form-info {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .form-info h2 {
            margin-bottom: 10px;
            color: #333;
        }

        .form-info p {
            color: #666;
            margin: 5px 0;
        }

        .canvas-container {
            position: relative;
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.2);
            overflow: auto;
            display: flex;
            justify-content: center;
            padding: 20px;
            min-height: 600px;
        }

        .pdf-canvas-wrapper {
            position: relative;
            background: white;
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

        #pdf-canvas {
            display: block;
        }

        .overlay-layer {
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
        }

        .form-field {
            position: absolute;
            border: 1px solid #667eea;
            background: rgba(255, 255, 255, 0.95);
            border-radius: 4px;
            padding: 4px;
        }

        .form-field-label {
            font-size: 0.75rem;
            color: #667eea;
            font-weight: 600;
            margin-bottom: 4px;
        }

        .form-field-input {
            width: 100%;
            border: 1px solid #ddd;
            border-radius: 4px;
            padding: 6px;
            font-size: 0.9rem;
        }

        .form-field-input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
        }

        .signature-canvas {
            border: 1px dashed #ccc;
            border-radius: 4px;
            cursor: crosshair;
            background: white;
            display: block;
            width: 100%;
            height: 100%;
            touch-action: none;
        }

        .signature-container {
            width: 100%;
            height: 100%;
            display: flex;
            flex-direction: column;
            min-height: 80px;
        }

        .signature-controls {
            margin-top: 5px;
            display: flex;
            gap: 5px;
        }

        .signature-controls button {
            padding: 4px 8px;
            font-size: 0.8rem;
            border: 1px solid #ddd;
            border-radius: 4px;
            background: white;
            cursor: pointer;
        }

        .signature-controls button:hover {
            background: #f0f0f0;
        }

        .unit-input-group {
            display: flex;
            gap: 5px;
        }

        .unit-input-group input {
            flex: 1;
        }

        .unit-display {
            padding: 6px 10px;
            background: #f0f0f0;
            border: 1px solid #ddd;
            border-radius: 4px;
            display: flex;
            align-items: center;
            font-size: 0.9rem;
        }

        .required-marker {
            color: #dc3545;
            margin-left: 3px;
        }

        .save-section {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-top: 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
            text-align: center;
        }

        .error-message {
            background: #f8d7da;
            color: #721c24;
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📝 Data Entry</h1>
        <div class="header-actions">
            <button class="btn btn-success" onclick="saveData()">Save Data</button>
            <a href="index.php" class="btn btn-primary">← Back</a>
        </div>
    </div>

    <div class="container">
        <div id="formInfo" class="form-info">
            <h2>Loading form...</h2>
        </div>

        <div id="errorMessage" class="error-message" style="display: none;"></div>

        <div class="canvas-container">
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

        <div class="save-section">
            <button class="btn btn-success" onclick="saveData()" style="padding: 12px 30px; font-size: 1rem;">
                💾 Save Batch Record Data
            </button>
        </div>
    </div>

    <script src="js/data-entry.js"></script>
    <script>
        const formId = '<?php echo isset($_GET["form"]) ? htmlspecialchars($_GET["form"]) : ""; ?>';
        const pdfFile = '<?php echo isset($_GET["pdf"]) ? htmlspecialchars($_GET["pdf"]) : ""; ?>';

        if (formId || pdfFile) {
            initDataEntry(formId, pdfFile);
        } else {
            document.getElementById('formInfo').innerHTML =
                '<div class="error-message">No form specified. Please select a form from the main page.</div>';
        }
    </script>
</body>
</html>
