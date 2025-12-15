<?php
/**
 * Save form data entry
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request method']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON data']);
    exit;
}

// Validate required fields
if (empty($data['formId']) || empty($data['data'])) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

// Use data directory from config
$dataDir = DATA_DIR;
if (!file_exists($dataDir)) {
    mkdir($dataDir, 0755, true);
    file_put_contents($dataDir . '.gitkeep', '');
}

// Sanitize form ID for filename
$sanitizedFormId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $data['formId']);
$filename = $sanitizedFormId . '_' . date('Y-m-d_His') . '_' . uniqid() . '.json';
$filepath = $dataDir . '/' . $filename;

// Prepare data entry record
$dataEntry = [
    'id' => uniqid('entry_'),
    'formId' => $data['formId'],
    'formName' => $data['formName'] ?? '',
    'pdfFile' => $data['pdfFile'] ?? '',
    'data' => $data['data'],
    'savedAt' => $data['savedAt'] ?? date('c'),
    'filename' => $filename
];

if (file_put_contents($filepath, json_encode($dataEntry, JSON_PRETTY_PRINT))) {
    echo json_encode([
        'success' => true,
        'message' => 'Data saved successfully',
        'entryId' => $dataEntry['id'],
        'filename' => $filename
    ]);
} else {
    echo json_encode(['success' => false, 'message' => 'Failed to save data']);
}
