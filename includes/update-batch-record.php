<?php
/**
 * Update batch record (e.g. set status to completed, or update lastEntryId on data save)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid method']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data || empty($data['batchId'])) {
    echo json_encode(['success' => false, 'message' => 'Missing batchId']);
    exit;
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $data['batchId']);

if (ebr_debug_save_enabled()) {
    error_log(
        'ebr update-batch-record [debug]: request batchId=' . $batchId
        . ' status=' . ($data['status'] ?? '')
        . ' keys=' . implode(',', array_keys($data))
    );
}

$record = ebr_db_batch_fetch_by_id($batchId);
if ($record === null) {
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: batch not found for id=' . $batchId);
    }
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

$record = ebr_batch_record_ensure_batch_id($record);

$now = date('c');
$record['updatedAt'] = $now;

if (isset($data['status']) && $data['status'] === 'completed') {
    $record['status'] = 'completed';
    $record['completedAt'] = $now;
    if (!empty($data['completedSignOffBy'])) {
        $record['completedSignOffBy'] = trim((string) $data['completedSignOffBy']);
    }
    if (!empty($data['completedSignOffAt'])) {
        $record['completedSignOffAt'] = trim((string) $data['completedSignOffAt']);
    }
}
if (isset($data['lastEntryId'])) {
    $record['lastEntryId'] = $data['lastEntryId'];
}

try {
    $saved = ebr_db_batch_save_from_api($record);
} catch (Throwable $e) {
    error_log('ebr update-batch-record: ' . $e->getMessage());
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: ' . $e->getFile() . ':' . $e->getLine() . ' ' . $e->getTraceAsString());
    }
    $fail = ['success' => false, 'message' => 'Failed to update'];
    if (ebr_debug_save_enabled()) {
        $fail['detail'] = $e->getMessage();
    }
    http_response_code(500);
    echo json_encode($fail);
    exit;
}

if ($saved === null) {
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: ebr_db_batch_save_from_api returned null for batchId=' . $batchId);
    }
    echo json_encode(['success' => false, 'message' => 'Failed to update']);
    exit;
}

$out = ['success' => true, 'batch' => $saved];
if (ebr_debug_save_enabled()) {
    $out['debugInfo'] = [
        'step' => 'updated',
        'batchId' => $saved['id'] ?? $batchId,
        'status' => $saved['status'] ?? null,
        'completedAt' => $saved['completedAt'] ?? null,
        'lastEntryId' => $saved['lastEntryId'] ?? null,
    ];
    error_log(
        'ebr update-batch-record [debug]: success id=' . ($saved['id'] ?? '')
        . ' status=' . ($saved['status'] ?? '')
    );
}

echo json_encode($out);
