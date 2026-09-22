<?php
/**
 * Form access roster (who may edit a form, and who may manage that list).
 *
 *   GET  ?formId=...  → { collaborators: [...], canEdit, canManage, creator }
 *   POST { formId, add: [{dbUserId, role}], remove: [dbUserId], setRole: [{dbUserId, role}] }
 *
 * Only an owner (or an app admin) may change the roster, and the last owner
 * cannot be removed or demoted — a form always has someone who can grant access.
 * The roster is written to every version of the form; see
 * ebr_db_forms_set_collaborators_same_name_pdf.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/db-db-user.php';
require_once __DIR__ . '/form-permissions.php';

header('Content-Type: application/json');

function ebr_form_access_fail(string $message, int $status = 200, ?string $code = null): void
{
    if ($status !== 200) {
        http_response_code($status);
    }
    $out = ['success' => false, 'message' => $message];
    if ($code !== null) {
        $out['code'] = $code;
    }
    echo json_encode($out);
    exit;
}

$isPost = $_SERVER['REQUEST_METHOD'] === 'POST';
$input = [];
if ($isPost) {
    $input = json_decode((string) file_get_contents('php://input'), true);
    if (!is_array($input)) {
        ebr_form_access_fail('Invalid JSON');
    }
}

$formId = trim((string) ($isPost ? ($input['formId'] ?? '') : ($_GET['formId'] ?? '')));
if ($formId === '') {
    ebr_form_access_fail('Missing formId');
}

try {
    $form = ebr_db_forms_fetch_by_id($formId);
} catch (Throwable $e) {
    error_log('ebr form-collaborators: ' . $e->getMessage());
    ebr_form_access_fail('Could not read the form.', 500);
}
if (!$form) {
    ebr_form_access_fail('Form not found');
}

$sessionUser = ebr_current_user();

/** Roster plus the flags the UI needs, for both the GET and the POST reply. */
function ebr_form_access_payload(array $form, ?array $sessionUser): array
{
    return [
        'success' => true,
        'formId' => $form['id'],
        'formName' => $form['name'] ?? '',
        'collaborators' => ebr_form_roster($form),
        'canEdit' => ebr_form_user_can_edit($form, $sessionUser),
        'canManage' => ebr_form_user_can_manage_access($form, $sessionUser),
        'isOwned' => ebr_form_is_owned($form),
        'creator' => [
            'name' => $form['createdBy'] ?? '',
            'dbUserId' => (int) ($form['createdByUserId'] ?? 0) ?: null,
        ],
    ];
}

if (!$isPost) {
    echo json_encode(ebr_form_access_payload($form, $sessionUser));
    exit;
}

if (!ebr_form_user_can_manage_access($form, $sessionUser)) {
    ebr_form_access_fail(
        'Only an owner of this form can change who has access.',
        403,
        'not_an_owner'
    );
}

$actorId = $sessionUser !== null ? (int) $sessionUser['id'] : 0;
$actorName = $sessionUser !== null
    ? (($sessionUser['display_name'] ?? '') !== '' ? $sessionUser['display_name'] : $sessionUser['username'])
    : '';
if (trim((string) $actorName) === '') {
    $actorName = trim((string) ($input['userName'] ?? ''));
}
if (trim((string) $actorName) === '') {
    ebr_form_access_fail('User name is required for the audit trail.');
}

/** @return 'owner'|'editor' */
function ebr_form_access_role($raw): string
{
    return strtolower(trim((string) $raw)) === EBR_FORM_ROLE_OWNER
        ? EBR_FORM_ROLE_OWNER
        : EBR_FORM_ROLE_EDITOR;
}

/**
 * [dbUserId => role] from an add/setRole list; entries without a usable id are
 * skipped (the picker always sends db_user ids).
 *
 * @return array<int, string>
 */
function ebr_form_access_role_map($raw): array
{
    $out = [];
    if (!is_array($raw)) {
        return $out;
    }
    foreach ($raw as $c) {
        $id = is_array($c) ? (int) ($c['dbUserId'] ?? 0) : (int) $c;
        if ($id > 0) {
            $out[$id] = ebr_form_access_role(is_array($c) ? ($c['role'] ?? '') : '');
        }
    }

    return $out;
}

/** @return list<int> */
function ebr_form_access_id_list($raw): array
{
    $out = [];
    if (!is_array($raw)) {
        return $out;
    }
    foreach ($raw as $c) {
        $id = is_array($c) ? (int) ($c['dbUserId'] ?? 0) : (int) $c;
        if ($id > 0) {
            $out[$id] = true;
        }
    }

    return array_keys($out);
}

$toAdd = ebr_form_access_role_map($input['add'] ?? []);
$toSetRole = ebr_form_access_role_map($input['setRole'] ?? []);
$toRemove = ebr_form_access_id_list($input['remove'] ?? []);
if ($toAdd === [] && $toSetRole === [] && $toRemove === []) {
    ebr_form_access_fail('Nothing to change.');
}

// Revoked entries are kept (see EBR_FORM_ROLE_REVOKED) so the write-back keeps them.
$roster = ebr_form_roster_all($form);
$now = date('c');
$changes = [];

// Giving access to a form that had none makes it owned, so it needs an owner:
// whoever does it takes ownership, exactly as creating a form does.
$claiming = !ebr_form_is_owned($form) && $roster === [];
if ($claiming && $actorId > 0) {
    $actorRow = ebr_db_user_fetch_by_id($actorId);
    $roster[] = [
        'dbUserId' => $actorId,
        'username' => $actorRow !== null ? (string) ($actorRow['username'] ?? '') : (string) ($sessionUser['username'] ?? ''),
        'displayName' => $actorRow !== null ? ebr_db_user_display_name($actorRow) : (string) $actorName,
        'role' => EBR_FORM_ROLE_OWNER,
        'addedByUserId' => $actorId,
        'addedAt' => $now,
        'isCreator' => false,
    ];
    $changes[] = ['action' => 'added', 'name' => (string) $actorName, 'role' => EBR_FORM_ROLE_OWNER];
}

// Index by db_user id; entries with no id (very old rows) can only be removed.
$byId = [];
foreach ($roster as $i => $entry) {
    if ((int) $entry['dbUserId'] > 0) {
        $byId[(int) $entry['dbUserId']] = $i;
    }
}

try {
    foreach ($toAdd as $id => $role) {
        $userRow = ebr_db_user_fetch_by_id($id);
        if ($userRow === null) {
            ebr_form_access_fail('Account #' . $id . ' no longer exists in db_user.');
        }
        if (ebr_db_user_is_disabled($userRow)) {
            ebr_form_access_fail(ebr_db_user_display_name($userRow) . ' is disabled in db_user.');
        }
        $displayName = ebr_db_user_display_name($userRow);
        if (isset($byId[$id])) {
            // Already has access: treat as a role change rather than a duplicate.
            $toSetRole[$id] = $role;
            continue;
        }
        $roster[] = [
            'dbUserId' => $id,
            'username' => (string) ($userRow['username'] ?? ''),
            'displayName' => $displayName,
            'role' => $role,
            'addedByUserId' => $actorId > 0 ? $actorId : null,
            'addedAt' => $now,
            'isCreator' => false,
        ];
        $byId[$id] = count($roster) - 1;
        $changes[] = ['action' => 'added', 'name' => $displayName, 'role' => $role];
    }

    foreach ($toSetRole as $id => $role) {
        if (!isset($byId[$id])) {
            continue;
        }
        $i = $byId[$id];
        if ($roster[$i]['role'] === $role) {
            continue;
        }
        $changes[] = [
            'action' => 'role',
            'name' => $roster[$i]['displayName'],
            'from' => $roster[$i]['role'],
            'role' => $role,
        ];
        $roster[$i]['role'] = $role;
    }

    $creatorId = (int) ($form['createdByUserId'] ?? 0);
    foreach ($toRemove as $id) {
        if (!isset($byId[$id])) {
            continue;
        }
        $i = $byId[$id];
        if ($roster[$i]['role'] === EBR_FORM_ROLE_REVOKED) {
            continue;
        }
        $changes[] = ['action' => 'removed', 'name' => $roster[$i]['displayName'], 'role' => $roster[$i]['role']];
        if ($id === $creatorId) {
            // Keep the creator as a tombstone, or they return as implicit owner.
            $roster[$i]['role'] = EBR_FORM_ROLE_REVOKED;
            continue;
        }
        unset($roster[$i]);
        $roster = array_values($roster);
        $byId = [];
        foreach ($roster as $j => $entry) {
            if ((int) $entry['dbUserId'] > 0) {
                $byId[(int) $entry['dbUserId']] = $j;
            }
        }
    }
} catch (Throwable $e) {
    error_log('ebr form-collaborators update: ' . $e->getMessage());
    ebr_form_access_fail('Could not update access.', 500);
}

if ($changes === []) {
    echo json_encode(ebr_form_access_payload($form, $sessionUser));
    exit;
}

$owners = array_values(array_filter(
    $roster,
    static fn(array $e): bool => $e['role'] === EBR_FORM_ROLE_OWNER
));
// No verifiable identity to take ownership (login bypassed): the first person
// added becomes the owner, so the form is never left without one.
if ($owners === [] && $claiming) {
    foreach ($roster as $i => $entry) {
        if ($entry['role'] === EBR_FORM_ROLE_EDITOR) {
            $roster[$i]['role'] = EBR_FORM_ROLE_OWNER;
            foreach ($changes as $j => $c) {
                if (($c['name'] ?? '') === $entry['displayName']) {
                    $changes[$j]['role'] = EBR_FORM_ROLE_OWNER;
                }
            }
            $owners[] = $roster[$i];
            break;
        }
    }
}
if ($owners === []) {
    ebr_form_access_fail(
        'A form must keep at least one owner. Grant owner rights to someone else first.',
        409,
        'last_owner'
    );
}

$creatorId = (int) ($form['createdByUserId'] ?? 0);
$creatorRevoked = $creatorId > 0
    && isset($byId[$creatorId])
    && $roster[$byId[$creatorId]]['role'] === EBR_FORM_ROLE_REVOKED;
$stored = ebr_form_roster_for_storage($roster);

$auditEntry = [
    'type' => 'access_changed',
    'user' => $actorName,
    'timestamp' => $now,
    'changes' => $changes,
    'version' => number_format((float) ($form['version'] ?? 1), 1),
];

try {
    $written = ebr_db_forms_set_collaborators_same_name_pdf(
        (string) $form['name'],
        (string) $form['pdfFile'],
        $stored
    );

    // Record it against the latest version, where the form audit page reads.
    $latest = null;
    foreach (ebr_db_forms_all_api() as $f) {
        if (($f['name'] ?? '') !== ($form['name'] ?? '') || ($f['pdfFile'] ?? '') !== ($form['pdfFile'] ?? '')) {
            continue;
        }
        if ($latest === null || (float) ($f['version'] ?? 0) > (float) ($latest['version'] ?? 0)) {
            $latest = $f;
        }
    }
    $target = $latest ?? $form;
    $trail = is_array($target['auditTrail'] ?? null) ? $target['auditTrail'] : [];
    $auditEntry['version'] = number_format((float) ($target['version'] ?? 1), 1);
    $trail[] = $auditEntry;
    ebr_db_forms_set_audit_trail((string) $target['id'], $trail);

    $form = ebr_db_forms_fetch_by_id($formId) ?? $form;
} catch (Throwable $e) {
    error_log('ebr form-collaborators write: ' . $e->getMessage());
    ebr_form_access_fail('Could not save the access list.', 500);
}

$payload = ebr_form_access_payload($form, $sessionUser);
$payload['versionsUpdated'] = $written;
if ($creatorRevoked) {
    $payload['message'] = 'Access updated. The original creator no longer has access to this form.';
}
echo json_encode($payload);
