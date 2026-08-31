<?php
/**
 * Update batch record (e.g. set status to completed, or update lastEntryId on data save)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-batch-collab.php';
require_once __DIR__ . '/db-db-user.php';

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

if (ebr_debug_save_enabled()) {
    error_log(
        'ebr update-batch-record [debug]: request batchId=' . $batchId
        . ' status=' . ($data['status'] ?? '')
        . ' keys=' . implode(',', array_keys($data))
    );
}

$record = ebr_db_batch_fetch_by_id($batchId);
if ($record === null) {
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: batch not found for id=' . $batchId);
    }
    echo json_encode(['success' => false, 'message' => 'Batch record not found']);
    exit;
}

$record = ebr_batch_record_ensure_batch_id($record);

$sessionUser = ebr_current_user();
if (!ebr_db_collab_user_can_write($record, $sessionUser)) {
    http_response_code(403);
    echo json_encode([
        'success' => false,
        'message' => 'You are not a collaborator on this batch record, so you cannot change it.',
        'code' => 'not_a_collaborator',
    ]);
    exit;
}

$now = date('c');
$record['updatedAt'] = $now;

if (isset($data['status']) && $data['status'] === 'completed') {
    // Completing a batch is a signature, not routine entry: the signer re-authenticates here
    // even if they already hold an open Live Collab window.
    if (ebr_collab_verification_available()) {
        $signUsername = trim((string) ($data['signOffUsername'] ?? ''));
        $signPassword = (string) ($data['signOffPassword'] ?? '');

        if ($signUsername === '' || $signPassword === '') {
            echo json_encode([
                'success' => false,
                'message' => 'Completing this batch requires the signer to enter their own username and password.',
                'code' => 'signoff_credentials_required',
            ]);
            exit;
        }

        try {
            $signer = ebr_db_user_fetch_by_username($signUsername);
        } catch (Throwable $e) {
            error_log('ebr update-batch-record signoff: ' . $e->getMessage());
            echo json_encode(['success' => false, 'message' => 'Sign-off verification unavailable.']);
            exit;
        }

        if ($signer === null || !ebr_db_user_verify_password($signPassword, $signer['password'] ?? null)) {
            echo json_encode([
                'success' => false,
                'message' => 'Those credentials were not recognised.',
                'code' => 'signoff_invalid_credentials',
            ]);
            exit;
        }
        if (ebr_db_user_is_disabled($signer)) {
            echo json_encode(['success' => false, 'message' => 'That account is disabled in db_user.']);
            exit;
        }
        if (!ebr_db_collab_is_member($batchId, (int) $signer['db_user_id'])) {
            echo json_encode([
                'success' => false,
                'message' => ebr_db_user_display_name($signer) . ' is not a collaborator on this batch.',
                'code' => 'signoff_not_a_collaborator',
            ]);
            exit;
        }

        $record['completedSignOffBy'] = ebr_db_user_display_name($signer);
        $record['completedSignOffUserId'] = (int) $signer['db_user_id'];
    } elseif (!empty($data['completedSignOffBy'])) {
        // Password checking is off on this deployment; keep the name, claim no verification.
        $record['completedSignOffBy'] = trim((string) $data['completedSignOffBy']);
    }

    $record['status'] = 'completed';
    $record['completedAt'] = $now;
    $record['completedSignOffAt'] = $now;
}
if (isset($data['lastEntryId'])) {
    $record['lastEntryId'] = $data['lastEntryId'];
}

try {
    $saved = ebr_db_batch_save_from_api($record);
} catch (Throwable $e) {
    error_log('ebr update-batch-record: ' . $e->getMessage());
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: ' . $e->getFile() . ':' . $e->getLine() . ' ' . $e->getTraceAsString());
    }
    $fail = ['success' => false, 'message' => 'Failed to update'];
    if (ebr_debug_save_enabled()) {
        $fail['detail'] = $e->getMessage();
    }
    http_response_code(500);
    echo json_encode($fail);
    exit;
}

if ($saved === null) {
    if (ebr_debug_save_enabled()) {
        error_log('ebr update-batch-record [debug]: ebr_db_batch_save_from_api returned null for batchId=' . $batchId);
    }
    echo json_encode(['success' => false, 'message' => 'Failed to update']);
    exit;
}

$out = ['success' => true, 'batch' => $saved];
if (ebr_debug_save_enabled()) {
    $out['debugInfo'] = [
        'step' => 'updated',
        'batchId' => $saved['id'] ?? $batchId,
        'status' => $saved['status'] ?? null,
        'completedAt' => $saved['completedAt'] ?? null,
        'lastEntryId' => $saved['lastEntryId'] ?? null,
    ];
    error_log(
        'ebr update-batch-record [debug]: success id=' . ($saved['id'] ?? '')
        . ' status=' . ($saved['status'] ?? '')
    );
}

echo json_encode($out);
