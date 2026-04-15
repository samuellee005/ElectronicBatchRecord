<?php
/**
 * Create a new batch record (in progress)
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

if (!$data || empty($data['formId'])) {
    echo json_encode(['success' => false, 'message' => 'Missing formId']);
    exit;
}

$title = trim($data['title'] ?? '');
$description = trim($data['description'] ?? '');
$formId = $data['formId'];
$formName = $data['formName'] ?? '';
$pdfFile = isset($data['pdfFile']) ? basename($data['pdfFile']) : '';
$createdBy = isset($data['createdBy']) ? trim($data['createdBy']) : null;

if ($title === '') {
    echo json_encode(['success' => false, 'message' => 'Title is required']);
    exit;
}

$id = ebr_generate_batch_id($createdBy);
$now = date('c');
$record = [
    'id' => $id,
    'batchId' => $id,
    'formId' => $formId,
    'formName' => $formName,
    'pdfFile' => $pdfFile,
    'title' => $title,
    'description' => $description,
    'status' => 'in_progress',
    'createdAt' => $now,
    'updatedAt' => $now,
    'completedAt' => null,
    'createdBy' => $createdBy,
    'lastEntryId' => null,
];

$path = BATCH_RECORDS_DIR . $id . '.json';
if (file_put_contents($path, json_encode($record, JSON_PRETTY_PRINT))) {
    echo json_encode(['success' => true, 'batchId' => $id, 'batch' => $record]);
} else {
    echo json_encode(['success' => false, 'message' => 'Failed to save batch record']);
}
