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
if (!$fileKey || !isset($_FILES[$fileKey]) || $_FILES[$fileKey]['error'] !== UPLOAD_ERR_OK) {
    echo json_encode(['success' => false, 'message' => 'No file uploaded or upload error']);
    exit;
}

$result = handleFileUpload($_FILES[$fileKey]);
echo json_encode($result);
