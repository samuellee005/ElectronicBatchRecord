<?php
/**
 * List all uploaded PDF files
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

$uploadDir = UPLOAD_DIR;
$pdfs = [];

if (file_exists($uploadDir)) {
    $files = glob($uploadDir . '*.pdf');
    foreach ($files as $file) {
        $filename = basename($file);
        $pdfs[] = [
            'name' => $filename,
            'display_name' => pathinfo($filename, PATHINFO_FILENAME),
            'size' => filesize($file),
            'path' => $file,
            'uploaded' => filemtime($file)
        ];
    }
    usort($pdfs, function ($a, $b) { return ($b['uploaded'] ?? 0) - ($a['uploaded'] ?? 0); });
}

echo json_encode([
    'success' => true,
    'pdfs' => $pdfs
]);
