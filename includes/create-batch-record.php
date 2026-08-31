<?php
/**
 * Create a new batch record (in progress)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-batch-collab.php';
require_once __DIR__ . '/db-active-users.php';
require_once __DIR__ . '/db-db-user.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid method']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data || empty($data['formId'])) {
    echo json_encode(['success' => false, 'message' => 'Missing formId']);
    exit;
}

$title = trim($data['title'] ?? '');
$description = trim($data['description'] ?? '');
$formId = $data['formId'];
$formName = $data['formName'] ?? '';
$pdfFile = isset($data['pdfFile']) ? basename($data['pdfFile']) : '';
// Authorship comes from the session, never the request body — a batch record must not be
// able to claim an author the caller did not sign in as.
$sessionUser = ebr_current_user();
$createdBy = $sessionUser !== null ? ebr_current_display_name() : '';
if ($createdBy === '' && isset($data['createdBy'])) {
    // EBR_REQUIRE_LOGIN off: no session to derive from, fall back to the client value.
    $createdBy = trim((string) $data['createdBy']);
}
$createdBy = $createdBy !== '' ? $createdBy : null;
$createdByUserId = $sessionUser !== null ? (int) $sessionUser['id'] : 0;

if ($title === '') {
    echo json_encode(['success' => false, 'message' => 'Title is required']);
    exit;
}

/**
 * Collaborators designated at creation. Each must be a linked, active entry on the EBR
 * roster — an unlinked name cannot be re-authenticated later, so it cannot be a collaborator.
 *
 * @var list<array<string, mixed>> $collaboratorRows db_user rows
 */
$collaboratorRows = [];
$requestedIds = [];
if (isset($data['collaborators']) && is_array($data['collaborators'])) {
    foreach ($data['collaborators'] as $c) {
        $cid = is_array($c) ? (int) ($c['dbUserId'] ?? 0) : (int) $c;
        if ($cid > 0) {
            $requestedIds[$cid] = true;
        }
    }
}

foreach (array_keys($requestedIds) as $cid) {
    try {
        $rosterEntry = ebr_db_active_user_find_by_db_user_id($cid);
        $userRow = ebr_db_user_fetch_by_id($cid);
    } catch (Throwable $e) {
        error_log('ebr create-batch-record collaborators: ' . $e->getMessage());
        echo json_encode(['success' => false, 'message' => 'Could not verify the selected collaborators.']);
        exit;
    }

    if ($userRow === null) {
        echo json_encode([
            'success' => false,
            'message' => 'A selected collaborator (account #' . $cid . ') no longer exists in db_user.',
        ]);
        exit;
    }
    if (ebr_db_user_is_disabled($userRow)) {
        echo json_encode([
            'success' => false,
            'message' => ebr_db_user_display_name($userRow) . ' is disabled in db_user and cannot be a collaborator.',
        ]);
        exit;
    }
    if ($rosterEntry === null || empty($rosterEntry['active'])) {
        echo json_encode([
            'success' => false,
            'message' => ebr_db_user_display_name($userRow)
                . ' is not an active entry on the EBR user roster. Add them under User administration first.',
        ]);
        exit;
    }

    $collaboratorRows[] = $userRow;
}

$id = ebr_generate_batch_id($createdBy);
$now = date('c');
$record = [
    'id' => $id,
    'batchId' => $id,
    'formId' => $formId,
    'formName' => $formName,
    'pdfFile' => $pdfFile,
    'title' => $title,
    'description' => $description,
    'status' => 'in_progress',
    'createdAt' => $now,
    'updatedAt' => $now,
    'completedAt' => null,
    'createdBy' => $createdBy,
    'createdByUserId' => $createdByUserId > 0 ? $createdByUserId : null,
    'lastEntryId' => null,
];

try {
    ebr_db_batch_insert($record);
} catch (Throwable $e) {
    error_log('ebr create-batch-record: ' . $e->getMessage());
    $msg = 'Failed to save batch record to database.';
    if (str_contains($e->getMessage(), 'fk_ebr_batch_form') || str_contains($e->getMessage(), 'foreign key')) {
        $msg = 'This form is not in the database yet. Save the form in the form builder, then create the batch again.';
    }
    echo json_encode(['success' => false, 'message' => $msg]);
    exit;
}

// The creator participates in their own batch, so they join the roster automatically.
if ($createdByUserId > 0) {
    try {
        $creatorRow = ebr_db_user_fetch_by_id($createdByUserId);
        if ($creatorRow !== null) {
            array_unshift($collaboratorRows, $creatorRow);
        }
    } catch (Throwable $e) {
        error_log('ebr create-batch-record creator collab: ' . $e->getMessage());
    }
}

$actor = [
    'id' => $createdByUserId,
    'username' => $sessionUser !== null ? $sessionUser['username'] : '',
];
$collaboratorWarnings = [];
foreach ($collaboratorRows as $row) {
    try {
        ebr_db_collab_add($id, $row, $actor);
    } catch (Throwable $e) {
        error_log('ebr create-batch-record collab add: ' . $e->getMessage());
        $collaboratorWarnings[] = ebr_db_user_display_name($row);
    }
}

try {
    $collaborators = ebr_db_collab_list($id);
} catch (Throwable $e) {
    $collaborators = [];
}

$out = ['success' => true, 'batchId' => $id, 'batch' => $record, 'collaborators' => $collaborators];
if ($collaboratorWarnings !== []) {
    $out['message'] = 'Batch created, but these collaborators could not be added: '
        . implode(', ', $collaboratorWarnings);
}

echo json_encode($out);
