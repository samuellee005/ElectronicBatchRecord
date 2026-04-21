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

if (empty($data['formId']) || !array_key_exists('data', $data)) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

// Do not use empty($data['data']) — JSON {} becomes [] in PHP and is incorrectly "empty".
$dataPayload = $data['data'];
if ($dataPayload === null) {
    $dataPayload = [];
}
if (!is_array($dataPayload)) {
    $dataPayload = [];
}

$sanitizedFormId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $data['formId']);
$filename = $sanitizedFormId . '_' . date('Y-m-d_His') . '_' . uniqid() . '.json';

$entryId = uniqid('entry_');
$batchIdRaw = $data['batchId'] ?? null;
$batchId = ($batchIdRaw !== null && $batchIdRaw !== '')
    ? preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $batchIdRaw)
    : null;
if ($batchId === '') {
    $batchId = null;
}

$dataEntry = [
    'id' => $entryId,
    'formId' => $data['formId'],
    'formName' => $data['formName'] ?? '',
    'pdfFile' => $data['pdfFile'] ?? '',
    'batchId' => $batchId,
    'data' => $dataPayload,
    'stageCompletion' => $data['stageCompletion'] ?? [],
    'stages' => $data['stages'] ?? [],
    'savedAt' => $data['savedAt'] ?? date('c'),
    'filename' => $filename,
];

try {
    ebr_db_data_entry_insert($dataEntry);
} catch (Throwable $e) {
    error_log('ebr save-data: ' . $e->getMessage());
    http_response_code(500);
    $msg = 'Failed to save data to database.';
    $em = $e->getMessage();
    if (str_contains($em, '23503') || str_contains($em, 'foreign key')) {
        $msg = 'Save failed: this form or batch is not in the database (open the latest saved form from Batch Record Forms and use a valid batch).';
    } elseif (str_contains($em, '23505') || str_contains($em, 'duplicate key') || str_contains($em, 'unique')) {
        $msg = 'Save failed: duplicate entry. Try saving again.';
    }
    $show = getenv('EBR_SHOW_UPLOAD_ERRORS');
    if ($show !== false && $show !== '' && strtolower((string) $show) !== '0' && strtolower((string) $show) !== 'false') {
        echo json_encode(['success' => false, 'message' => $msg, 'detail' => $em]);
    } else {
        echo json_encode(['success' => false, 'message' => $msg]);
    }
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
