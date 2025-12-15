<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>PDF Background Template Uploader</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
        }

        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            border-radius: 12px;
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
            overflow: hidden;
        }

        .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 30px;
            text-align: center;
        }

        .header h1 {
            font-size: 2rem;
            margin-bottom: 10px;
        }

        .header p {
            opacity: 0.9;
            font-size: 1rem;
        }

        .content {
            padding: 40px;
        }

        .upload-section {
            margin-bottom: 30px;
        }

        .upload-form {
            border: 2px dashed #667eea;
            border-radius: 8px;
            padding: 40px;
            text-align: center;
            transition: all 0.3s ease;
            background: #f8f9fa;
        }

        .upload-form:hover {
            border-color: #764ba2;
            background: #f0f0f0;
        }

        .upload-form.dragover {
            border-color: #764ba2;
            background: #e8e8ff;
        }

        .file-input-wrapper {
            position: relative;
            display: inline-block;
            margin-bottom: 20px;
        }

        .file-input {
            position: absolute;
            opacity: 0;
            width: 100%;
            height: 100%;
            cursor: pointer;
        }

        .file-input-label {
            display: inline-block;
            padding: 12px 24px;
            background: #667eea;
            color: white;
            border-radius: 6px;
            cursor: pointer;
            transition: background 0.3s ease;
            font-weight: 500;
        }

        .file-input-label:hover {
            background: #764ba2;
        }

        .file-name {
            margin-top: 15px;
            color: #666;
            font-size: 0.9rem;
        }

        .upload-btn {
            padding: 12px 30px;
            background: #667eea;
            color: white;
            border: none;
            border-radius: 6px;
            font-size: 1rem;
            font-weight: 500;
            cursor: pointer;
            transition: background 0.3s ease;
            margin-top: 20px;
        }

        .upload-btn:hover {
            background: #764ba2;
        }

        .upload-btn:disabled {
            background: #ccc;
            cursor: not-allowed;
        }

        .message {
            padding: 15px;
            border-radius: 6px;
            margin-bottom: 20px;
            font-size: 0.95rem;
        }

        .message.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }

        .message.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }

        .templates-section {
            margin-top: 40px;
        }

        .templates-section h2 {
            margin-bottom: 20px;
            color: #333;
        }

        .template-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
            gap: 15px;
        }

        .template-item {
            border: 1px solid #ddd;
            border-radius: 8px;
            padding: 15px;
            text-align: center;
            transition: transform 0.2s ease, box-shadow 0.2s ease;
            background: white;
        }

        .template-item:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
        }

        .template-item a {
            text-decoration: none;
            color: #667eea;
            font-weight: 500;
        }

        .template-item a:hover {
            color: #764ba2;
        }

        .template-name {
            margin-top: 10px;
            font-size: 0.9rem;
            color: #666;
            word-break: break-word;
        }

        .empty-state {
            text-align: center;
            padding: 40px;
            color: #999;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>📄 PDF Background Template</h1>
            <p>Upload PDF files to use as background templates</p>
        </div>

        <div class="content">
            <?php
            require_once 'config.php';
            require_once 'includes/functions.php';

            // Handle file upload
            if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_FILES['pdf_file'])) {
                $result = handleFileUpload($_FILES['pdf_file']);
                if ($result['success']) {
                    echo '<div class="message success">' . htmlspecialchars($result['message']) . '</div>';
                } else {
                    echo '<div class="message error">' . htmlspecialchars($result['message']) . '</div>';
                }
            }

            // Display existing templates
            $templates = getUploadedTemplates();
            ?>

            <div class="upload-section">
                <form action="" method="POST" enctype="multipart/form-data" class="upload-form" id="uploadForm">
                    <div class="file-input-wrapper">
                        <input type="file" name="pdf_file" id="pdf_file" class="file-input" accept=".pdf" required>
                        <label for="pdf_file" class="file-input-label">Choose PDF File</label>
                    </div>
                    <div class="file-name" id="fileName"></div>
                    <button type="submit" class="upload-btn" id="uploadBtn">Upload PDF</button>
                </form>
            </div>

            <div class="templates-section">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                    <h2>Uploaded Templates</h2>
                    <a href="forms-list.php" style="padding: 10px 20px; background: #28a745; color: white; text-decoration: none; border-radius: 6px; font-size: 0.9rem;">
                        📋 View Saved Forms
                    </a>
                </div>
                <?php if (empty($templates)): ?>
                    <div class="empty-state">
                        <p>No templates uploaded yet. Upload your first PDF above!</p>
                    </div>
                <?php else: ?>
                    <div class="template-list">
                        <?php foreach ($templates as $template): ?>
                            <div class="template-item">
                                <a href="view.php?file=<?php echo urlencode($template['name']); ?>">
                                    📄 View Template
                                </a>
                                <a href="form-builder.php?file=<?php echo urlencode($template['name']); ?>" style="display: block; margin-top: 8px;">
                                    🏗️ Build Form
                                </a>
                                <div class="template-name"><?php echo htmlspecialchars($template['display_name']); ?></div>
                                <div class="template-name" style="font-size: 0.8rem; color: #999;">
                                    <?php echo formatFileSize($template['size']); ?>
                                </div>
                            </div>
                        <?php endforeach; ?>
                    </div>
                <?php endif; ?>
            </div>
        </div>
    </div>

    <script>
        const fileInput = document.getElementById('pdf_file');
        const fileName = document.getElementById('fileName');
        const uploadForm = document.getElementById('uploadForm');
        const uploadBtn = document.getElementById('uploadBtn');

        // Display selected file name
        fileInput.addEventListener('change', function(e) {
            if (e.target.files.length > 0) {
                fileName.textContent = 'Selected: ' + e.target.files[0].name;
                uploadBtn.disabled = false;
            } else {
                fileName.textContent = '';
                uploadBtn.disabled = true;
            }
        });

        // Drag and drop functionality
        uploadForm.addEventListener('dragover', function(e) {
            e.preventDefault();
            uploadForm.classList.add('dragover');
        });

        uploadForm.addEventListener('dragleave', function(e) {
            e.preventDefault();
            uploadForm.classList.remove('dragover');
        });

        uploadForm.addEventListener('drop', function(e) {
            e.preventDefault();
            uploadForm.classList.remove('dragover');

            if (e.dataTransfer.files.length > 0) {
                fileInput.files = e.dataTransfer.files;
                fileName.textContent = 'Selected: ' + e.dataTransfer.files[0].name;
                uploadBtn.disabled = false;
            }
        });
    </script>
</body>
</html>
