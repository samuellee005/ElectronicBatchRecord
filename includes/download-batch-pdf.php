<?php
/**
 * Export a batch record as PDF (saved entry data). Any status; empty fields if nothing saved yet.
 * Requires FPDI (vendor/autoload.php). Design coordinates are at scale 1.5 vs PDF points.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-data-entries.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/pdf-batch-export.php';

if (!isset($_GET['batchId'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'batchId required']);
    exit;
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['batchId']);

try {
    $batch = ebr_db_batch_fetch_by_id($batchId);
} catch (Throwable $e) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Batch not found']);
    exit;
}

if ($batch === null || empty($batch['formId'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Invalid batch']);
    exit;
}

$batch = ebr_batch_record_ensure_batch_id($batch);

[$formData, $entryRaw] = ebr_db_entry_resolve_for_batch($batch, $batchId);
if (!$entryRaw) {
    $formData = [];
}

$formId = $batch['formId'];
$form = null;
try {
    $form = ebr_db_forms_fetch_by_id($formId);
} catch (Throwable $e) {
    $form = null;
}
if (!$form && is_dir(FORMS_DIR)) {
    foreach (glob(FORMS_DIR . '/*.json') ?: [] as $formFile) {
        $fd = json_decode(file_get_contents($formFile), true);
        if (!$fd || ($fd['id'] ?? '') !== $formId) {
            continue;
        }
        if ($form === null || ($fd['version'] ?? 0) > ($form['version'] ?? 0)) {
            $form = $fd;
        }
    }
}

if (!$form || empty($form['fields']) || empty($form['pdfFile'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Form or template not found']);
    exit;
}

try {
    $bin = ebr_build_batch_pdf_binary($form, $formData, $batch);
} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    exit;
}

$safeTitle = preg_replace('/[^a-zA-Z0-9_-]/', '_', $batch['title'] ?? 'batch');
$filename = $safeTitle . '_' . date('Y-m-d') . '.pdf';

header('Content-Type: application/pdf');
header('Content-Disposition: attachment; filename="' . $filename . '"');
echo $bin;
exit;
