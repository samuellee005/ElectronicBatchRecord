<?php
/**
 * List batch records (optional filter by status)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';

header('Content-Type: application/json');

$status = isset($_GET['status']) ? trim($_GET['status']) : '';
if ($status === '' || !in_array($status, ['in_progress', 'completed'], true)) {
    $status = 'in_progress';
}

$filterByCreator = isset($_GET['createdBy']) ? trim($_GET['createdBy']) : '';

try {
    $records = ebr_db_batch_list($status, $filterByCreator !== '' ? $filterByCreator : null);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Could not load batch records', 'records' => []]);
    exit;
}

$out = [];
foreach ($records as $data) {
    $data = ebr_batch_record_ensure_batch_id($data);
    $out[] = [
        'id' => $data['id'],
        'batchId' => $data['batchId'],
        'formId' => $data['formId'] ?? '',
        'formName' => $data['formName'] ?? '',
        'pdfFile' => $data['pdfFile'] ?? '',
        'title' => $data['title'] ?? '',
        'description' => $data['description'] ?? '',
        'status' => $data['status'] ?? 'in_progress',
        'createdAt' => $data['createdAt'] ?? '',
        'updatedAt' => $data['updatedAt'] ?? '',
        'completedAt' => $data['completedAt'] ?? null,
        'createdBy' => $data['createdBy'] ?? null,
    ];
}

echo json_encode(['success' => true, 'records' => $out]);
