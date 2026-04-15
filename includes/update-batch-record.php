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
$path = BATCH_RECORDS_DIR . $batchId . '.json';

if (!file_exists($path)) {
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

$record = json_decode(file_get_contents($path), true);
if (!$record) {
    echo json_encode(['success' => false, 'message' => 'Invalid batch record']);
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

if (file_put_contents($path, json_encode($record, JSON_PRETTY_PRINT))) {
    echo json_encode(['success' => true, 'batch' => $record]);
} else {
    echo json_encode(['success' => false, 'message' => 'Failed to update']);
}
