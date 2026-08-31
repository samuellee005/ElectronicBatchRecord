<?php
/**
 * Save form data entry (PostgreSQL ebr_data_entries)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-data-entries.php';
require_once __DIR__ . '/db-batch-collab.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/entry-attribution.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request method']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON data']);
    exit;
}

if (empty($data['formId']) || !array_key_exists('data', $data)) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

// Do not use empty($data['data']) — JSON {} becomes [] in PHP and is incorrectly "empty".
$dataPayload = $data['data'];
if ($dataPayload === null) {
    $dataPayload = [];
}
if (!is_array($dataPayload)) {
    $dataPayload = [];
}

$sanitizedFormId = preg_replace('/[^a-zA-Z0-9_-]/', '_', $data['formId']);
$filename = $sanitizedFormId . '_' . date('Y-m-d_His') . '_' . uniqid() . '.json';

$entryId = uniqid('entry_');
$batchIdRaw = $data['batchId'] ?? null;
$batchId = ($batchIdRaw !== null && $batchIdRaw !== '')
    ? preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $batchIdRaw)
    : null;
if ($batchId === '') {
    $batchId = null;
}

$sessionUser = ebr_current_user();

// Writes to a batch are limited to its creator and current collaborators; viewing stays open.
// Attribution claims in the payload are then checked against the Live Collab presence ledger.
if ($batchId !== null) {
    try {
        $batchRecord = ebr_db_batch_fetch_by_id($batchId);
    } catch (Throwable $e) {
        // Never fall through to an unchecked save: if the batch cannot be read, neither the
        // write gate nor the attribution check can run.
        error_log('ebr save-data batch fetch: ' . $e->getMessage());
        http_response_code(503);
        echo json_encode([
            'success' => false,
            'message' => 'Could not read the batch record to check permissions. Nothing was saved.',
        ]);
        exit;
    }

    if ($batchRecord !== null) {
        if (!ebr_db_collab_user_can_write($batchRecord, $sessionUser)) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'message' => 'You are not a collaborator on this batch record, so you cannot save data to it.',
                'code' => 'not_a_collaborator',
            ]);
            exit;
        }

        $fieldLabels = [];
        try {
            $form = ebr_db_forms_fetch_by_id((string) $data['formId']);
            foreach ((($form['fields'] ?? []) ?: []) as $f) {
                if (is_array($f) && isset($f['id'])) {
                    $fieldLabels[(string) $f['id']] = trim((string) ($f['label'] ?? '')) ?: (string) $f['id'];
                }
            }
        } catch (Throwable $e) {
            // Labels are only used to make error messages readable.
        }

        $checked = ebr_attribution_validate_payload(
            $dataPayload,
            $batchId,
            ebr_collab_verification_available(),
            $fieldLabels
        );
        if ($checked['errors'] !== []) {
            http_response_code(422);
            echo json_encode([
                'success' => false,
                'message' => 'Some entries could not be attributed to a verified user, so nothing was saved.',
                'code' => 'attribution_invalid',
                'errors' => array_values(array_slice($checked['errors'], 0, 20)),
            ]);
            exit;
        }
        $dataPayload = $checked['data'];
    }
}

$dataEntry = [
    'id' => $entryId,
    'formId' => $data['formId'],
    'formName' => $data['formName'] ?? '',
    'pdfFile' => $data['pdfFile'] ?? '',
    'batchId' => $batchId,
    'data' => $dataPayload,
    'stageCompletion' => $data['stageCompletion'] ?? [],
    'stages' => $data['stages'] ?? [],
    'savedAt' => $data['savedAt'] ?? date('c'),
    'filename' => $filename,
    'savedByUserId' => $sessionUser !== null ? $sessionUser['id'] : null,
    'savedByUsername' => $sessionUser !== null ? $sessionUser['username'] : '',
];

if (ebr_debug_save_enabled()) {
    $dataKeys = is_array($dataPayload) ? array_keys($dataPayload) : [];
    error_log(
        'ebr save-data [debug]: insert entry_id=' . $entryId
        . ' form_id=' . ($data['formId'] ?? '')
        . ' batch_id=' . ($batchId ?? 'null')
        . ' data_fields=' . count($dataKeys)
        . ' sample_keys=' . implode(',', array_slice($dataKeys, 0, 12))
    );
}

try {
    ebr_db_data_entry_insert($dataEntry);
} catch (Throwable $e) {
    error_log('ebr save-data: ' . $e->getMessage());
    if (ebr_debug_save_enabled()) {
        error_log('ebr save-data [debug] trace: ' . $e->getFile() . ':' . $e->getLine());
    }
    http_response_code(500);
    $msg = 'Failed to save data to database.';
    $em = $e->getMessage();
    if (str_contains($em, '23503') || str_contains($em, 'foreign key')) {
        $msg = 'Save failed: this form or batch is not in the database (open the latest saved form from Batch Record Forms and use a valid batch).';
    } elseif (str_contains($em, '23505') || str_contains($em, 'duplicate key') || str_contains($em, 'unique')) {
        $msg = 'Save failed: duplicate entry. Try saving again.';
    }
    $show = getenv('EBR_SHOW_UPLOAD_ERRORS');
    if ($show !== false && $show !== '' && strtolower((string) $show) !== '0' && strtolower((string) $show) !== 'false') {
        echo json_encode(['success' => false, 'message' => $msg, 'detail' => $em]);
    } else {
        echo json_encode(['success' => false, 'message' => $msg]);
    }
    exit;
}

if ($batchId !== null && $batchId !== '') {
    try {
        ebr_db_batch_touch_last_entry($batchId, $entryId, $filename);
    } catch (Throwable $e) {
        if (ebr_debug_save_enabled()) {
            error_log('ebr save-data [debug]: batch_touch_failed batch_id=' . $batchId . ' ' . $e->getMessage());
        }
        // Non-fatal
    }
}

$out = [
    'success' => true,
    'message' => 'Data saved successfully',
    'entryId' => $entryId,
    'filename' => $filename,
];
if (ebr_debug_save_enabled()) {
    $out['debugInfo'] = [
        'step' => 'saved',
        'entryId' => $entryId,
        'formId' => $data['formId'],
        'batchId' => $batchId,
        'dataFieldCount' => is_array($dataPayload) ? count($dataPayload) : 0,
        'storageFilename' => $filename,
    ];
    error_log('ebr save-data [debug]: success entry_id=' . $entryId . ' batch_touch=' . ($batchId !== null && $batchId !== '' ? 'yes' : 'skipped'));
}

echo json_encode($out);
