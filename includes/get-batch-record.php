<?php
/**
 * Get a single batch record with its form config and latest saved form data.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-data-entries.php';
require_once __DIR__ . '/db-forms.php';

header('Content-Type: application/json');

if (!isset($_GET['batchId'])) {
    echo json_encode(['success' => false, 'message' => 'batchId required']);
    exit;
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['batchId']);

try {
    $batch = ebr_db_batch_fetch_by_id($batchId);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

if ($batch === null || empty($batch['formId'])) {
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

$batch = ebr_batch_record_ensure_batch_id($batch);

[$formData, $entryRaw] = ebr_db_entry_resolve_for_batch($batch, $batchId);

$formId = $batch['formId'];
try {
    $foundForm = ebr_db_forms_fetch_by_id($formId);
} catch (Throwable $e) {
    $foundForm = null;
}

if (!$foundForm && ebr_legacy_json_fallback_enabled() && is_dir(FORMS_DIR)) {
    foreach (glob(FORMS_DIR . '/*.json') ?: [] as $formFile) {
        $fd = json_decode(file_get_contents($formFile), true);
        if (!$fd || ($fd['id'] ?? '') !== $formId) {
            continue;
        }
        if ($foundForm === null || ($fd['version'] ?? 0) > ($foundForm['version'] ?? 0)) {
            $foundForm = $fd;
        }
    }
}

if (!$foundForm) {
    echo json_encode(['success' => false, 'message' => 'Form not found']);
    exit;
}

echo json_encode([
    'success' => true,
    'batch' => $batch,
    'form' => $foundForm,
    'formData' => $formData,
    'entry' => $entryRaw,
]);
