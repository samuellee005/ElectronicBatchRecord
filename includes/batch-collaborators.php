<?php
/**
 * Batch collaborator roster.
 *
 *   GET  ?batchId=...            → { collaborators: [...] } (current members)
 *   GET  ?batchId=...&history=1  → includes removed members
 *   POST { batchId, add: [dbUserId], remove: [dbUserId] }
 *
 * Only the batch creator or a current collaborator may change the roster.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-batch-collab.php';
require_once __DIR__ . '/db-active-users.php';
require_once __DIR__ . '/db-db-user.php';

header('Content-Type: application/json');

function ebr_collab_fail(string $message, int $status = 200): void
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
        ebr_collab_fail('Invalid JSON');
    }
}

$batchIdRaw = $isPost ? ($input['batchId'] ?? '') : ($_GET['batchId'] ?? '');
$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) $batchIdRaw);
if ($batchId === '') {
    ebr_collab_fail('Missing batchId');
}

try {
    $batch = ebr_db_batch_fetch_by_id($batchId);
} catch (Throwable $e) {
    error_log('ebr batch-collaborators: ' . $e->getMessage());
    ebr_collab_fail('Could not read the batch record.', 500);
}
if ($batch === null) {
    ebr_collab_fail('Batch record not found');
}

$sessionUser = ebr_current_user();

if (!$isPost) {
    $includeRemoved = isset($_GET['history']) && $_GET['history'] === '1';
    try {
        $collaborators = ebr_db_collab_list($batchId, $includeRemoved);
    } catch (Throwable $e) {
        error_log('ebr batch-collaborators list: ' . $e->getMessage());
        ebr_collab_fail('Could not load collaborators.', 500);
    }

    echo json_encode([
        'success' => true,
        'batchId' => $batchId,
        'collaborators' => $collaborators,
        'canWrite' => ebr_db_collab_user_can_write($batch, $sessionUser),
    ]);
    exit;
}

if (($batch['status'] ?? '') === 'completed') {
    ebr_collab_fail('This batch is complete; its collaborator roster is locked.');
}
if (!ebr_db_collab_user_can_write($batch, $sessionUser)) {
    ebr_collab_fail('Only the batch creator or a current collaborator can change the roster.', 403);
}

$actor = [
    'id' => $sessionUser !== null ? (int) $sessionUser['id'] : 0,
    'username' => $sessionUser !== null ? $sessionUser['username'] : '',
];

/** @return list<int> */
function ebr_collab_id_list($raw): array
{
    if (!is_array($raw)) {
        return [];
    }
    $out = [];
    foreach ($raw as $c) {
        $id = is_array($c) ? (int) ($c['dbUserId'] ?? 0) : (int) $c;
        if ($id > 0) {
            $out[$id] = true;
        }
    }

    return array_keys($out);
}

try {
    foreach (ebr_collab_id_list($input['add'] ?? []) as $cid) {
        $rosterEntry = ebr_db_active_user_find_by_db_user_id($cid);
        $userRow = ebr_db_user_fetch_by_id($cid);

        if ($userRow === null) {
            ebr_collab_fail('Account #' . $cid . ' no longer exists in db_user.');
        }
        if (ebr_db_user_is_disabled($userRow)) {
            ebr_collab_fail(ebr_db_user_display_name($userRow) . ' is disabled in db_user.');
        }
        if ($rosterEntry === null || empty($rosterEntry['active'])) {
            ebr_collab_fail(
                ebr_db_user_display_name($userRow)
                . ' is not an active entry on the EBR user roster. Add them under User administration first.'
            );
        }

        ebr_db_collab_add($batchId, $userRow, $actor);
    }

    foreach (ebr_collab_id_list($input['remove'] ?? []) as $cid) {
        // Ending their presence too, so a removed person cannot keep recording under an
        // already-open window.
        foreach (ebr_db_presence_active($batchId) as $p) {
            if ((int) $p['dbUserId'] === $cid) {
                ebr_db_presence_end((string) $p['id']);
            }
        }
        ebr_db_collab_remove($batchId, $cid, $actor);
    }

    $collaborators = ebr_db_collab_list($batchId);
} catch (Throwable $e) {
    error_log('ebr batch-collaborators update: ' . $e->getMessage());
    ebr_collab_fail('Could not update collaborators.', 500);
}

if ($collaborators === []) {
    // Not fatal, but the batch is now unusable for entry until someone is added back.
    echo json_encode([
        'success' => true,
        'batchId' => $batchId,
        'collaborators' => [],
        'message' => 'This batch now has no collaborators. Data entry is blocked until at least one is added.',
    ]);
    exit;
}

echo json_encode(['success' => true, 'batchId' => $batchId, 'collaborators' => $collaborators]);
