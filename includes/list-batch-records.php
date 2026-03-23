<?php
/**
 * List batch records (optional filter by status)
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

$status = isset($_GET['status']) ? trim($_GET['status']) : '';
if (!in_array($status, ['in_progress', 'completed'], true)) {
    echo json_encode(['success' => true, 'records' => []]);
    exit;
}

$filterByCreator = isset($_GET['createdBy']) ? trim($_GET['createdBy']) : '';

$dir = BATCH_RECORDS_DIR;
$records = [];

if (is_dir($dir)) {
    $files = glob($dir . '/*.json');
    foreach ($files as $file) {
        $data = @json_decode(file_get_contents($file), true);
        if (!$data || !isset($data['id'])) continue;
        if ($data['status'] !== $status) continue;
        if ($filterByCreator !== '') {
            $creator = trim((string) ($data['createdBy'] ?? ''));
            if (strcasecmp($creator, $filterByCreator) !== 0) {
                continue;
            }
        }
        $records[] = [
            'id' => $data['id'],
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
}

usort($records, function ($a, $b) {
    $tA = $a['updatedAt'] ?: $a['createdAt'];
    $tB = $b['updatedAt'] ?: $b['createdAt'];
    return strcmp($tB, $tA);
});

echo json_encode(['success' => true, 'records' => $records]);
