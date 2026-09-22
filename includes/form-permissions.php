<?php
/**
 * Who may edit a form and who may change its access list.
 *
 * A form's roster lives in `ebr_forms.collaborators` (JSONB) as
 *   { dbUserId, username, displayName, role: 'owner'|'editor', addedByUserId, addedAt }
 * Two roles:
 *   - editor: may edit the form and save new versions
 *   - owner:  that, plus adding/removing people and granting owner rights
 * Entries written before roles existed have no `role` and read as editors; the
 * form's createdByUserId is always an owner, so an existing form keeps working
 * without a migration.
 *
 * Forms created before ownership existed carry no verified creator id and no
 * collaborators. Those stay open to everyone (see ebr_form_is_owned), which is
 * how the app has always treated them.
 */

const EBR_FORM_ROLE_OWNER = 'owner';
const EBR_FORM_ROLE_EDITOR = 'editor';
/**
 * Tombstone for someone whose access was taken away. It only matters for the
 * creator, who is otherwise an implicit owner and would come back on the next
 * read; the entry is stored, skipped everywhere access is checked, and hidden
 * from the roster the UI shows.
 */
const EBR_FORM_ROLE_REVOKED = 'revoked';

/**
 * Normalized roster entries for a form, the creator included as an owner.
 *
 * @param array<string, mixed> $form form as returned by ebr_db_form_row_to_api
 * @return list<array{dbUserId:int, username:string, displayName:string, role:string, addedByUserId:int|null, addedAt:string|null, isCreator:bool}>
 */
function ebr_form_roster(array $form): array
{
    return array_values(array_filter(
        ebr_form_roster_all($form),
        static fn(array $e): bool => $e['role'] !== EBR_FORM_ROLE_REVOKED
    ));
}

/**
 * As ebr_form_roster, but keeping revoked entries — for writing the list back.
 *
 * @return list<array<string, mixed>>
 */
function ebr_form_roster_all(array $form): array
{
    $creatorId = (int) ($form['createdByUserId'] ?? 0);
    $creatorName = trim((string) ($form['createdBy'] ?? ''));
    $raw = is_array($form['collaborators'] ?? null) ? $form['collaborators'] : [];

    $out = [];
    $seenIds = [];
    foreach ($raw as $c) {
        if (!is_array($c)) {
            continue;
        }
        $id = (int) ($c['dbUserId'] ?? 0);
        $username = trim((string) ($c['username'] ?? ''));
        $displayName = trim((string) ($c['displayName'] ?? ''));
        if ($id <= 0 && $username === '' && $displayName === '') {
            continue;
        }
        // The creator is an owner whatever the stored entry says.
        $isCreator = $id > 0 && $id === $creatorId;
        $role = strtolower(trim((string) ($c['role'] ?? '')));
        if ($role !== EBR_FORM_ROLE_OWNER && $role !== EBR_FORM_ROLE_REVOKED) {
            $role = EBR_FORM_ROLE_EDITOR;
        }
        // The creator is an owner unless their access was explicitly revoked.
        if ($isCreator && $role !== EBR_FORM_ROLE_REVOKED) {
            $role = EBR_FORM_ROLE_OWNER;
        }
        $addedBy = isset($c['addedByUserId']) && (int) $c['addedByUserId'] > 0
            ? (int) $c['addedByUserId']
            : null;
        $entry = [
            'dbUserId' => $id,
            'username' => $username,
            'displayName' => $displayName !== '' ? $displayName : $username,
            'role' => $role,
            'addedByUserId' => $addedBy,
            'addedAt' => isset($c['addedAt']) && $c['addedAt'] !== '' ? (string) $c['addedAt'] : null,
            'isCreator' => $isCreator,
        ];
        // Later duplicates lose, but an owner role wins over an editor one.
        $key = $id > 0 ? 'i' . $id : 'u' . strtolower($username);
        if (isset($seenIds[$key])) {
            if ($entry['role'] === EBR_FORM_ROLE_OWNER) {
                $out[$seenIds[$key]]['role'] = EBR_FORM_ROLE_OWNER;
            }
            continue;
        }
        $seenIds[$key] = count($out);
        $out[] = $entry;
    }

    // A verified creator who is not in the list is still an owner.
    if ($creatorId > 0 && !isset($seenIds['i' . $creatorId])) {
        $out[] = [
            'dbUserId' => $creatorId,
            'username' => '',
            'displayName' => $creatorName !== '' ? $creatorName : ('User #' . $creatorId),
            'role' => EBR_FORM_ROLE_OWNER,
            'addedByUserId' => null,
            'addedAt' => isset($form['createdAt']) && $form['createdAt'] !== '' ? (string) $form['createdAt'] : null,
            'isCreator' => true,
        ];
    }

    return $out;
}

/** @return list<array<string, mixed>> roster entries with owner rights */
function ebr_form_owners(array $form): array
{
    return array_values(array_filter(
        ebr_form_roster($form),
        static fn(array $e): bool => $e['role'] === EBR_FORM_ROLE_OWNER
    ));
}

/**
 * Whether the form has an access list at all. Forms saved before ownership
 * existed have neither a verified creator nor collaborators and stay open.
 */
function ebr_form_is_owned(array $form): bool
{
    $collabs = is_array($form['collaborators'] ?? null) ? $form['collaborators'] : [];

    return (int) ($form['createdByUserId'] ?? 0) > 0 || !empty($collabs);
}

/** Admins are named in EBR_ADMIN_USERNAMES; see ebr_db_user_to_session_payload. */
function ebr_form_is_admin(?array $sessionUser): bool
{
    return $sessionUser !== null && ($sessionUser['role'] ?? '') === 'admin';
}

/**
 * Whether a roster entry is this user. Matches on the verified db_user id, and
 * on username for entries stored before ids were recorded.
 */
function ebr_form_entry_is_user(array $entry, int $userId, string $username): bool
{
    if ($userId > 0 && (int) ($entry['dbUserId'] ?? 0) === $userId) {
        return true;
    }
    $eu = strtolower(trim((string) ($entry['username'] ?? '')));

    return $username !== '' && $eu !== '' && $eu === $username;
}

/**
 * Whether this user created the form. `created_by` holds a display name, so the
 * fallback compares against the session display name as well as the username —
 * comparing it to the username alone never matched a real db_user login.
 */
function ebr_form_user_is_creator(array $form, ?array $sessionUser): bool
{
    if ($sessionUser === null) {
        return false;
    }
    $creatorId = (int) ($form['createdByUserId'] ?? 0);
    $actorId = (int) ($sessionUser['id'] ?? 0);
    if ($creatorId > 0) {
        return $actorId > 0 && $actorId === $creatorId;
    }
    // No verified creator id: fall back to the recorded name.
    $creatorName = strtolower(trim((string) ($form['createdBy'] ?? '')));
    if ($creatorName === '') {
        return false;
    }
    $username = strtolower(trim((string) ($sessionUser['username'] ?? '')));
    $display = strtolower(trim((string) ($sessionUser['display_name'] ?? '')));

    return ($username !== '' && $username === $creatorName)
        || ($display !== '' && $display === $creatorName);
}

/**
 * Whether the creator's own access was taken away (see EBR_FORM_ROLE_REVOKED).
 * They keep the `createdBy` attribution on every version either way.
 */
function ebr_form_creator_is_revoked(array $form): bool
{
    $creatorId = (int) ($form['createdByUserId'] ?? 0);
    if ($creatorId <= 0) {
        return false;
    }
    foreach (ebr_form_roster_all($form) as $entry) {
        if ((int) $entry['dbUserId'] === $creatorId) {
            return $entry['role'] === EBR_FORM_ROLE_REVOKED;
        }
    }

    return false;
}

/** The creator has access unless it was explicitly revoked. */
function ebr_form_user_is_active_creator(array $form, ?array $sessionUser): bool
{
    return ebr_form_user_is_creator($form, $sessionUser) && !ebr_form_creator_is_revoked($form);
}

/** Whether the user may edit the form's content and save versions. */
function ebr_form_user_can_edit(array $form, ?array $sessionUser): bool
{
    if (!ebr_form_is_owned($form)) {
        return true;
    }
    if (ebr_form_user_is_active_creator($form, $sessionUser)) {
        return true;
    }
    if ($sessionUser === null) {
        return false;
    }
    $actorId = (int) ($sessionUser['id'] ?? 0);
    $username = strtolower(trim((string) ($sessionUser['username'] ?? '')));
    foreach (ebr_form_roster($form) as $entry) {
        if (ebr_form_entry_is_user($entry, $actorId, $username)) {
            return true;
        }
    }

    return false;
}

/**
 * Whether the user may change who has access. Owners can; so can an admin, so a
 * form whose owners have all left the company is not stranded. An unowned
 * legacy form can be claimed by anyone who may edit it.
 */
function ebr_form_user_can_manage_access(array $form, ?array $sessionUser): bool
{
    if (!ebr_form_is_owned($form)) {
        return ebr_form_user_can_edit($form, $sessionUser);
    }
    if (ebr_form_is_admin($sessionUser)) {
        return true;
    }
    if (ebr_form_user_is_active_creator($form, $sessionUser)) {
        return true;
    }
    if ($sessionUser === null) {
        return false;
    }
    $actorId = (int) ($sessionUser['id'] ?? 0);
    $username = strtolower(trim((string) ($sessionUser['username'] ?? '')));
    foreach (ebr_form_owners($form) as $entry) {
        if (ebr_form_entry_is_user($entry, $actorId, $username)) {
            return true;
        }
    }

    return false;
}

/**
 * Roster entries as stored in the `collaborators` column (no derived keys).
 *
 * @param list<array<string, mixed>> $roster
 * @return list<array<string, mixed>>
 */
function ebr_form_roster_for_storage(array $roster): array
{
    $out = [];
    foreach ($roster as $e) {
        $out[] = [
            'dbUserId' => (int) ($e['dbUserId'] ?? 0),
            'username' => (string) ($e['username'] ?? ''),
            'displayName' => (string) ($e['displayName'] ?? ''),
            'role' => in_array($e['role'] ?? '', [EBR_FORM_ROLE_OWNER, EBR_FORM_ROLE_REVOKED], true)
                ? (string) $e['role']
                : EBR_FORM_ROLE_EDITOR,
            'addedByUserId' => isset($e['addedByUserId']) && (int) $e['addedByUserId'] > 0
                ? (int) $e['addedByUserId']
                : null,
            'addedAt' => isset($e['addedAt']) && $e['addedAt'] !== null && $e['addedAt'] !== ''
                ? (string) $e['addedAt']
                : null,
        ];
    }

    return $out;
}
