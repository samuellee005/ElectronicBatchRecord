<?php
/**
 * Upload PDF template - JSON API for React/frontend
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/functions.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$fileKey = isset($_FILES['pdf_file']) ? 'pdf_file' : (isset($_FILES['pdf']) ? 'pdf' : null);
if (!$fileKey || !isset($_FILES[$fileKey])) {
    echo json_encode(['success' => false, 'message' => 'No file uploaded']);
    exit;
}

$err = (int) ($_FILES[$fileKey]['error'] ?? UPLOAD_ERR_NO_FILE);
if ($err !== UPLOAD_ERR_OK) {
    $message = match ($err) {
        UPLOAD_ERR_INI_SIZE => 'File exceeds server upload size limit (check PHP upload_max_filesize / post_max_size).',
        UPLOAD_ERR_FORM_SIZE => 'File exceeds maximum allowed size.',
        UPLOAD_ERR_PARTIAL => 'The file was only partially uploaded.',
        UPLOAD_ERR_NO_FILE => 'No file was uploaded.',
        UPLOAD_ERR_NO_TMP_DIR => 'Server missing a temporary folder for uploads.',
        UPLOAD_ERR_CANT_WRITE => 'Failed to write file to disk.',
        UPLOAD_ERR_EXTENSION => 'A PHP extension blocked the upload.',
        default => 'Upload error (code ' . $err . ').',
    };
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

$result = handleFileUpload($_FILES[$fileKey]);
echo json_encode($result);
