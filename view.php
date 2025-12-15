<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>View PDF Template</title>
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
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .header-content {
            max-width: 1200px;
            margin: 0 auto;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .header h1 {
            font-size: 1.5rem;
        }

        .back-btn {
            padding: 10px 20px;
            background: rgba(255, 255, 255, 0.2);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            transition: background 0.3s ease;
            border: 1px solid rgba(255, 255, 255, 0.3);
        }

        .back-btn:hover {
            background: rgba(255, 255, 255, 0.3);
        }

        .container {
            max-width: 1200px;
            margin: 30px auto;
            padding: 0 20px;
        }

        .pdf-viewer {
            background: white;
            border-radius: 8px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
            min-height: 600px;
        }

        .pdf-viewer iframe {
            width: 100%;
            height: 800px;
            border: none;
        }

        .error-message {
            background: #f8d7da;
            color: #721c24;
            padding: 20px;
            border-radius: 8px;
            margin: 20px 0;
            border: 1px solid #f5c6cb;
        }

        .info-panel {
            background: white;
            padding: 20px;
            border-radius: 8px;
            margin-bottom: 20px;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
        }

        .info-panel p {
            margin: 5px 0;
            color: #666;
        }

        .info-panel strong {
            color: #333;
        }
    </style>
</head>
<body>
    <div class="header">
        <div class="header-content">
            <h1>📄 PDF Background Template Viewer</h1>
            <a href="index.php" class="back-btn">← Back to Upload</a>
        </div>
    </div>

    <div class="container">
        <?php
        require_once 'config.php';
        require_once 'includes/functions.php';

        if (!isset($_GET['file'])) {
            echo '<div class="error-message">No file specified.</div>';
            echo '<a href="index.php">← Back to Upload</a>';
            exit;
        }

        $filePath = validatePdfFile($_GET['file']);

        if (!$filePath) {
            echo '<div class="error-message">PDF file not found or invalid.</div>';
            echo '<a href="index.php">← Back to Upload</a>';
            exit;
        }

        $fileName = basename($filePath);
        $fileSize = filesize($filePath);
        $fileInfo = pathinfo($fileName);
        ?>

        <div class="info-panel">
            <p><strong>File Name:</strong> <?php echo htmlspecialchars($fileInfo['filename']); ?></p>
            <p><strong>File Size:</strong> <?php echo formatFileSize($fileSize); ?></p>
            <p><strong>Uploaded:</strong> <?php echo date('F j, Y g:i A', filemtime($filePath)); ?></p>
        </div>

        <div class="pdf-viewer">
            <iframe src="<?php echo htmlspecialchars('uploads/' . $fileName); ?>" type="application/pdf">
                <p>Your browser does not support PDFs.
                   <a href="<?php echo htmlspecialchars('uploads/' . $fileName); ?>" download>Download the PDF</a> instead.
                </p>
            </iframe>
        </div>
    </div>
</body>
</html>
