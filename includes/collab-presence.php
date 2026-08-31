<?php
/**
 * Live Collab presence state for a batch.
 *
 *   GET  ?batchId=...                     → who is currently verified, and for how long
 *   POST { batchId, presenceId, action:'end' } → close a window early ("step away")
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-batch-collab.php';

header('Content-Type: application/json');

function ebr_presence_fail(string $message, int $status = 200): void
{
    if ($status !== 200) {
        http_response_code($status);
    }
    echo json_encode(['success' => false, 'message' => $message]);
    exit;
}

$isPost = $_SERVER['REQUEST_METHOD'] === 'POST';
$input = [];
if ($isPost) {
    $input = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($input)) {
        ebr_presence_fail('Invalid JSON');
    }
}

$batchIdRaw = $isPost ? ($input['batchId'] ?? '') : ($_GET['batchId'] ?? '');
$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $batchIdRaw);
if ($batchId === '') {
    ebr_presence_fail('Missing batchId');
}

try {
    $batch = ebr_db_batch_fetch_by_id($batchId);
} catch (Throwable $e) {
    error_log('ebr collab-presence: ' . $e->getMessage());
    ebr_presence_fail('Could not read the batch record.', 500);
}
if ($batch === null) {
    ebr_presence_fail('Batch record not found');
}

$sessionUser = ebr_current_user();

if ($isPost) {
    if (($input['action'] ?? '') !== 'end') {
        ebr_presence_fail('Unsupported action');
    }
    $presenceId = trim((string) ($input['presenceId'] ?? ''));
    if ($presenceId === '') {
        ebr_presence_fail('Missing presenceId');
    }

    try {
        $presence = ebr_db_presence_fetch($presenceId);
        if ($presence === null || $presence['batchId'] !== $batchId) {
            ebr_presence_fail('That verification does not belong to this batch.');
        }
        ebr_db_presence_end($presenceId);
    } catch (Throwable $e) {
        error_log('ebr collab-presence end: ' . $e->getMessage());
        ebr_presence_fail('Could not end the session.', 500);
    }
}

try {
    ebr_db_presence_ensure_session($batchId, $sessionUser, ebr_collab_presence_minutes());
    $active = ebr_db_presence_active($batchId);
    $collaborators = ebr_db_collab_list($batchId);
} catch (Throwable $e) {
    error_log('ebr collab-presence list: ' . $e->getMessage());
    ebr_presence_fail('Could not load presence state.', 500);
}

echo json_encode([
    'success' => true,
    'batchId' => $batchId,
    'presence' => $active,
    'collaborators' => $collaborators,
    'presenceMinutes' => ebr_collab_presence_minutes(),
    'verificationAvailable' => ebr_collab_verification_available(),
    'canWrite' => ebr_db_collab_user_can_write($batch, $sessionUser),
    'sessionUser' => $sessionUser === null ? null : [
        'dbUserId' => $sessionUser['id'],
        'username' => $sessionUser['username'],
        'displayName' => ebr_current_display_name(),
    ],
    'serverTime' => date('c'),
]);
