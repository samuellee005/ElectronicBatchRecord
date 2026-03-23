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

$entryId = uniqid('entry_');
$dataEntry = [
    'id' => $entryId,
    'formId' => $data['formId'],
    'formName' => $data['formName'] ?? '',
    'pdfFile' => $data['pdfFile'] ?? '',
    'batchId' => $data['batchId'] ?? null,
    'data' => $data['data'],
    'stageCompletion' => $data['stageCompletion'] ?? [],
    'stages' => $data['stages'] ?? [],
    'savedAt' => $data['savedAt'] ?? date('c'),
    'filename' => $filename
];

if (!file_put_contents($filepath, json_encode($dataEntry, JSON_PRETTY_PRINT))) {
    echo json_encode(['success' => false, 'message' => 'Failed to save data']);
    exit;
}

if (!empty($data['batchId'])) {
    $batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $data['batchId']);
    $batchPath = BATCH_RECORDS_DIR . $batchId . '.json';
    if (file_exists($batchPath)) {
        $batch = json_decode(file_get_contents($batchPath), true);
        if ($batch && ($batch['status'] ?? '') === 'in_progress') {
            $batch['updatedAt'] = date('c');
            $batch['lastEntryId'] = $entryId;
            $batch['lastEntryFilename'] = $filename;
            file_put_contents($batchPath, json_encode($batch, JSON_PRETTY_PRINT));
        }
    }
}

echo json_encode([
    'success' => true,
    'message' => 'Data saved successfully',
    'entryId' => $entryId,
    'filename' => $filename
]);
