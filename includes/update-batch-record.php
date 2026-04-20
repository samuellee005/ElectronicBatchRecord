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

$record = ebr_db_batch_fetch_by_id($batchId);
if ($record === null) {
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
    echo json_encode(['success' => false, 'message' => 'Failed to update']);
    exit;
}

if ($saved === null) {
    echo json_encode(['success' => false, 'message' => 'Failed to update']);
    exit;
}

echo json_encode(['success' => true, 'batch' => $saved]);
