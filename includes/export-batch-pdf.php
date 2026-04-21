<?php
/**
 * POST JSON: generate batch PDF from current client data (saved or unsaved).
 * Body: { "formId", "pdfFile", "data": { ... field entries ... }, "batch": { optional title, completedSignOffBy, ... } }
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/pdf-batch-export.php';

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'POST required']);
    exit;
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Invalid JSON']);
    exit;
}

$formId = preg_replace('/[^a-zA-Z0-9_-]/', '', $body['formId'] ?? '');
$pdfFile = basename($body['pdfFile'] ?? '');
$data = $body['data'] ?? null;
$batchMeta = isset($body['batch']) && is_array($body['batch']) ? $body['batch'] : [];

if ($formId === '' || $pdfFile === '' || !is_array($data)) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'formId, pdfFile, and data are required']);
    exit;
}

$form = null;
try {
    $form = ebr_db_forms_fetch_by_id($formId);
} catch (Throwable $e) {
    $form = null;
}
if (!$form && ebr_legacy_json_fallback_enabled() && is_dir(FORMS_DIR)) {
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
    echo json_encode(['success' => false, 'message' => 'Form or template not found']);
    exit;
}

if (basename($form['pdfFile']) !== $pdfFile) {
    echo json_encode(['success' => false, 'message' => 'PDF template does not match form']);
    exit;
}

$batch = $batchMeta;
if (empty($batch['title'])) {
    $batch['title'] = $form['name'] ?? 'Batch';
}

try {
    $bin = ebr_build_batch_pdf_binary($form, $data, $batch);
} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
    exit;
}

$safeTitle = preg_replace('/[^a-zA-Z0-9_-]/', '_', $batch['title'] ?? 'batch');
$filename = $safeTitle . '_' . date('Y-m-d') . '.pdf';

header('Content-Type: application/pdf');
header('Content-Disposition: inline; filename="' . $filename . '"');
header('Cache-Control: private, max-age=0');
echo $bin;
exit;
