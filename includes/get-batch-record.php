<?php
/**
 * Get a single batch record with its form config and latest saved form data.
 * Used when viewing a batch (e.g. completed) to show data and enable PDF download.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';

header('Content-Type: application/json');

if (!isset($_GET['batchId'])) {
    echo json_encode(['success' => false, 'message' => 'batchId required']);
    exit;
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['batchId']);
$batchPath = BATCH_RECORDS_DIR . $batchId . '.json';

if (!file_exists($batchPath)) {
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

$batch = json_decode(file_get_contents($batchPath), true);
if (!$batch || empty($batch['formId'])) {
    echo json_encode(['success' => false, 'message' => 'Invalid batch record']);
    exit;
}

$batch = ebr_batch_record_ensure_batch_id($batch);

// Load latest entry data for this batch
$formData = [];
$entryRaw = null;

if (!empty($batch['lastEntryFilename'])) {
    $entryPath = DATA_DIR . $batch['lastEntryFilename'];
    if (file_exists($entryPath)) {
        $entryRaw = json_decode(file_get_contents($entryPath), true);
        if ($entryRaw && isset($entryRaw['data'])) {
            $formData = $entryRaw['data'];
        }
    }
}

if (!$entryRaw && !empty($batch['lastEntryId'])) {
    // Fallback: scan data dir for entry with this id (do not include batch-records subdir)
    $files = glob(DATA_DIR . '*.json');
    foreach ($files as $f) {
        if (strpos($f, 'batch-records') !== false) continue;
        $data = @json_decode(file_get_contents($f), true);
        if (!$data || ($data['id'] ?? '') !== $batch['lastEntryId']) continue;
        $entryRaw = $data;
        $formData = $data['data'] ?? [];
        break;
    }
}

if (!$entryRaw) {
    // No entry file yet: try any file that references this batchId
    $files = glob(DATA_DIR . '*.json');
    $latest = null;
    foreach ($files as $f) {
        if (strpos($f, 'batch-records') !== false) continue;
        $data = @json_decode(file_get_contents($f), true);
        if (!$data || ($data['batchId'] ?? '') !== $batchId) continue;
        $savedAt = $data['savedAt'] ?? '';
        if ($latest === null || strcmp($savedAt, $latest['savedAt'] ?? '') > 0) {
            $latest = $data;
        }
    }
    if ($latest) {
        $entryRaw = $latest;
        $formData = $latest['data'] ?? [];
    }
}

// Load form configuration
$formId = $batch['formId'];
$formsDir = FORMS_DIR;
$foundForm = null;

if (is_dir($formsDir)) {
    $formFiles = glob($formsDir . '/*.json');
    foreach ($formFiles as $formFile) {
        $fd = json_decode(file_get_contents($formFile), true);
        if (!$fd || ($fd['id'] ?? '') !== $formId) continue;
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
