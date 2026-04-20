<?php
/**
 * Helper functions for PDF upload and management
 */

require_once __DIR__ . '/../config.php';

/**
 * True if the file content looks like a PDF (Portable Document Format).
 * Accepts standard headers, optional UTF-8 BOM, and a %PDF marker within the first 1 KiB
 * (some generators add a short preamble).
 */
function ebr_file_looks_like_pdf(string $path): bool
{
    $buf = @file_get_contents($path, false, null, 0, 16384);
    if ($buf === false || $buf === '') {
        return false;
    }
    if (str_starts_with($buf, "\xEF\xBB\xBF")) {
        $buf = substr($buf, 3);
    }
    if (strlen($buf) >= 5 && substr($buf, 0, 5) === '%PDF-') {
        return true;
    }
    if (strlen($buf) >= 4 && substr($buf, 0, 4) === '%PDF') {
        return true;
    }
    $pos = strpos($buf, '%PDF');
    if ($pos !== false && $pos <= 1024) {
        return preg_match('/%PDF-[0-9]/', substr($buf, $pos, 32)) === 1;
    }

    return false;
}

/**
 * Handle file upload with validation
 */
function handleFileUpload($file) {
    // Check if file was uploaded
    if (!isset($file) || $file['error'] !== UPLOAD_ERR_OK) {
        return [
            'success' => false,
            'message' => 'Error uploading file. Please try again.'
        ];
    }

    // Validate file size
    if ($file['size'] > MAX_FILE_SIZE) {
        return [
            'success' => false,
            'message' => 'File size exceeds maximum allowed size of ' . formatFileSize(MAX_FILE_SIZE)
        ];
    }

    // Validate file type
    $fileExtension = strtolower(pathinfo($file['name'], PATHINFO_EXTENSION));
    if (!in_array($fileExtension, ALLOWED_EXTENSIONS)) {
        return [
            'success' => false,
            'message' => 'Invalid file type. Only PDF files are allowed.'
        ];
    }

    if (!ebr_file_looks_like_pdf($file['tmp_name'])) {
        return [
            'success' => false,
            'message' => 'This file is not a valid PDF. Use a real .pdf (Portable Document Format), not Word/Excel renamed to .pdf.'
        ];
    }

    // Generate unique filename
    $originalName = pathinfo($file['name'], PATHINFO_FILENAME);
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $originalName);
    $uniqueName = $sanitizedName . '_' . time() . '.pdf';
    $targetPath = UPLOAD_DIR . $uniqueName;

    // Move uploaded file
    if (move_uploaded_file($file['tmp_name'], $targetPath)) {
        return [
            'success' => true,
            'message' => 'PDF uploaded successfully!',
            'filename' => $uniqueName
        ];
    } else {
        return [
            'success' => false,
            'message' => 'Failed to save file. Please check directory permissions.'
        ];
    }
}

/**
 * Get list of uploaded PDF templates
 */
function getUploadedTemplates() {
    $templates = [];

    if (!is_dir(UPLOAD_DIR)) {
        return $templates;
    }

    $files = scandir(UPLOAD_DIR);

    foreach ($files as $file) {
        if ($file === '.' || $file === '..' || $file === '.gitkeep') {
            continue;
        }

        $filePath = UPLOAD_DIR . $file;

        if (is_file($filePath) && strtolower(pathinfo($file, PATHINFO_EXTENSION)) === 'pdf') {
            $templates[] = [
                'name' => $file,
                'display_name' => pathinfo($file, PATHINFO_FILENAME),
                'size' => filesize($filePath),
                'uploaded' => filemtime($filePath)
            ];
        }
    }

    // Sort by upload time (newest first)
    usort($templates, function($a, $b) {
        return $b['uploaded'] - $a['uploaded'];
    });

    return $templates;
}

/**
 * Format file size in human-readable format
 */
function formatFileSize($bytes) {
    if ($bytes >= 1073741824) {
        return number_format($bytes / 1073741824, 2) . ' GB';
    } elseif ($bytes >= 1048576) {
        return number_format($bytes / 1048576, 2) . ' MB';
    } elseif ($bytes >= 1024) {
        return number_format($bytes / 1024, 2) . ' KB';
    } else {
        return $bytes . ' bytes';
    }
}

/**
 * Validate PDF file exists and is accessible
 */
function validatePdfFile($filename) {
    // Sanitize filename to prevent directory traversal
    $filename = basename($filename);
    $filePath = UPLOAD_DIR . $filename;

    if (!file_exists($filePath)) {
        return false;
    }

    if (strtolower(pathinfo($filePath, PATHINFO_EXTENSION)) !== 'pdf') {
        return false;
    }

    return $filePath;
}
