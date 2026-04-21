<?php
/**
 * Helper functions for PDF upload and management
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-pdf-templates.php';

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

    $originalName = pathinfo($file['name'], PATHINFO_FILENAME);
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $originalName);
    if ($sanitizedName === '') {
        $sanitizedName = 'template';
    }
    // UNIQUE(filename): same stem + second can collide; add entropy.
    $uniqueName = $sanitizedName . '_' . time() . '_' . bin2hex(random_bytes(4)) . '.pdf';

    $binary = @file_get_contents($file['tmp_name']);
    if ($binary === false || $binary === '') {
        return [
            'success' => false,
            'message' => 'Could not read uploaded file.',
        ];
    }

    try {
        ebr_db_pdf_template_insert('tpl_' . bin2hex(random_bytes(8)), $uniqueName, (string) ($file['name'] ?? ''), $binary);
    } catch (Throwable $e) {
        error_log('ebr_db_pdf_template_insert: ' . $e->getMessage());
        $hint = '';
        $msg = $e->getMessage();
        if (str_contains($msg, 'ebr_pdf_templates') && str_contains($msg, 'does not exist')) {
            $hint = ' Run scripts/apply-schema.php (ensure database/schema.sql includes ebr_pdf_templates).';
        } elseif (str_contains($msg, '23505') || stripos($msg, 'duplicate key') !== false || stripos($msg, 'unique constraint') !== false) {
            $hint = ' Duplicate filename; try uploading again.';
        } elseif (str_contains($msg, 'permission denied') || str_contains($msg, 'must be owner')) {
            $hint = ' Database user may lack INSERT on ebr_pdf_templates.';
        }
        $show = getenv('EBR_SHOW_UPLOAD_ERRORS');
        if ($show !== false && $show !== '' && strtolower((string) $show) !== '0' && strtolower((string) $show) !== 'false') {
            return [
                'success' => false,
                'message' => 'Failed to store template in database.' . $hint,
                'detail' => $msg,
            ];
        }
        return [
            'success' => false,
            'message' => 'Failed to store template in database.' . $hint,
        ];
    }

    return [
        'success' => true,
        'message' => 'PDF uploaded successfully!',
        'filename' => $uniqueName,
    ];
}

/**
 * Get list of uploaded PDF templates
 */
function getUploadedTemplates()
{
    try {
        $rows = ebr_db_pdf_template_list_for_api();
    } catch (Throwable $e) {
        return [];
    }

    $templates = [];
    foreach ($rows as $r) {
        $templates[] = [
            'name' => $r['name'],
            'display_name' => $r['display_name'],
            'size' => $r['size'],
            'uploaded' => $r['uploaded'],
        ];
    }

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
function validatePdfFile($filename)
{
    $filename = basename((string) $filename);
    if (strtolower(pathinfo($filename, PATHINFO_EXTENSION)) !== 'pdf') {
        return false;
    }
    try {
        if (ebr_db_pdf_template_exists($filename)) {
            return true;
        }
    } catch (Throwable $e) {
        return false;
    }
    $legacy = UPLOAD_DIR . $filename;

    return file_exists($legacy) ? $legacy : false;
}
