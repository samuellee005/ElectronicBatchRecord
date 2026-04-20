<?php
/**
 * Save form data entry (PostgreSQL ebr_data_entries)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-data-entries.php';

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

if (empty($data['formId']) || empty($data['data'])) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

$sanitizedFormId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $data['formId']);
$filename = $sanitizedFormId . '_' . date('Y-m-d_His') . '_' . uniqid() . '.json';

$entryId = uniqid('entry_');
$batchIdRaw = $data['batchId'] ?? null;
$batchId = ($batchIdRaw !== null && $batchIdRaw !== '')
    ? preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $batchIdRaw)
    : null;

$dataEntry = [
    'id' => $entryId,
    'formId' => $data['formId'],
    'formName' => $data['formName'] ?? '',
    'pdfFile' => $data['pdfFile'] ?? '',
    'batchId' => $batchId,
    'data' => $data['data'],
    'stageCompletion' => $data['stageCompletion'] ?? [],
    'stages' => $data['stages'] ?? [],
    'savedAt' => $data['savedAt'] ?? date('c'),
    'filename' => $filename,
];

try {
    ebr_db_data_entry_insert($dataEntry);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Failed to save data to database.']);
    exit;
}

if ($batchId !== null && $batchId !== '') {
    try {
        ebr_db_batch_touch_last_entry($batchId, $entryId, $filename);
    } catch (Throwable $e) {
        // Non-fatal
    }
}

echo json_encode([
    'success' => true,
    'message' => 'Data saved successfully',
    'entryId' => $entryId,
    'filename' => $filename,
]);
