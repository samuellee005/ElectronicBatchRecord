<?php

declare(strict_types=1);

/**
 * Batch collaborators (ebr_batch_collaborators) and the Live Collab presence ledger
 * (ebr_batch_presence).
 *
 * Collaborators are designated at batch creation and are never hard-deleted — removing
 * someone stamps removed_at so the record keeps who was on it and when.
 *
 * Presence rows are the evidence behind per-entry attribution: each one records that a
 * person proved their identity with their own password at verified_at, and that the proof
 * was honoured until expires_at. The window is fixed; recording activity does not extend it.
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/db-batch-records.php'; // ebr_db_ts_to_iso()
require_once __DIR__ . '/db-db-user.php';

// ─── Collaborators ──────────────────────────────────────────────────────────

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function ebr_db_collab_row_to_api(array $row): array
{
    return [
        'id' => (string) $row['id'],
        'batchId' => (string) $row['batch_id'],
        'dbUserId' => (int) $row['db_user_id'],
        'username' => (string) $row['username'],
        'displayName' => (string) ($row['display_name'] ?? ''),
        'addedByUserId' => isset($row['added_by_user_id']) && $row['added_by_user_id'] !== null
            ? (int) $row['added_by_user_id'] : null,
        'addedByUsername' => (string) ($row['added_by_username'] ?? ''),
        'addedAt' => ebr_db_ts_to_iso($row['added_at'] ?? null),
        'removedByUsername' => (string) ($row['removed_by_username'] ?? ''),
        'removedAt' => ebr_db_ts_to_iso($row['removed_at'] ?? null),
        'active' => empty($row['removed_at']),
    ];
}

/**
 * @return list<array<string, mixed>>
 */
function ebr_db_collab_list(string $batchId, bool $includeRemoved = false): array
{
    if (trim($batchId) === '') {
        return [];
    }
    $pdo = ebr_pg_pdo();
    $sql = 'SELECT * FROM ebr_batch_collaborators WHERE batch_id = :b';
    if (!$includeRemoved) {
        $sql .= ' AND removed_at IS NULL';
    }
    $sql .= ' ORDER BY LOWER(display_name) ASC, added_at ASC';
    $st = $pdo->prepare($sql);
    $st->execute(['b' => $batchId]);

    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_collab_row_to_api($row);
    }

    return $out;
}

/**
 * Is this account a current (not removed) collaborator on the batch?
 */
function ebr_db_collab_is_member(string $batchId, int $dbUserId): bool
{
    if (trim($batchId) === '' || $dbUserId <= 0) {
        return false;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'SELECT 1 FROM ebr_batch_collaborators
         WHERE batch_id = :b AND db_user_id = :u AND removed_at IS NULL LIMIT 1'
    );
    $st->execute(['b' => $batchId, 'u' => $dbUserId]);

    return $st->fetchColumn() !== false;
}

/**
 * Add a collaborator. Re-adding someone previously removed inserts a fresh row so the
 * add/remove history stays intact. No-op when they are already active on the batch.
 *
 * @param array<string, mixed> $dbUserRow Row from db_user
 * @param array{id:int, username:string} $actor Session user performing the change
 */
function ebr_db_collab_add(string $batchId, array $dbUserRow, array $actor): void
{
    $dbUserId = (int) ($dbUserRow['db_user_id'] ?? 0);
    if ($dbUserId <= 0) {
        throw new InvalidArgumentException('Collaborator has no db_user_id');
    }
    if (ebr_db_collab_is_member($batchId, $dbUserId)) {
        return;
    }

    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'INSERT INTO ebr_batch_collaborators
            (id, batch_id, db_user_id, username, display_name, added_by_user_id, added_by_username, added_at)
         VALUES (:id, :b, :u, :un, :dn, :abi, :abu, NOW())'
    );
    $st->execute([
        'id' => uniqid('collab_', true),
        'b' => $batchId,
        'u' => $dbUserId,
        'un' => (string) ($dbUserRow['username'] ?? ''),
        'dn' => ebr_db_user_display_name($dbUserRow),
        'abi' => ((int) ($actor['id'] ?? 0)) > 0 ? (int) $actor['id'] : null,
        'abu' => (string) ($actor['username'] ?? '') ?: null,
    ]);
}

/**
 * Stamp a collaborator as removed. Returns false when they were not an active member.
 *
 * @param array{id:int, username:string} $actor
 */
function ebr_db_collab_remove(string $batchId, int $dbUserId, array $actor): bool
{
    if (trim($batchId) === '' || $dbUserId <= 0) {
        return false;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'UPDATE ebr_batch_collaborators
            SET removed_at = NOW(), removed_by_user_id = :rbi, removed_by_username = :rbu
          WHERE batch_id = :b AND db_user_id = :u AND removed_at IS NULL'
    );
    $st->execute([
        'b' => $batchId,
        'u' => $dbUserId,
        'rbi' => ((int) ($actor['id'] ?? 0)) > 0 ? (int) $actor['id'] : null,
        'rbu' => (string) ($actor['username'] ?? '') ?: null,
    ]);

    return $st->rowCount() > 0;
}

/**
 * Write access to a batch: the creator, or any current collaborator.
 * Viewing is open to every signed-in user; only writes are gated.
 *
 * @param array<string, mixed> $batch API-shaped batch row
 * @param array{id:int, username:string, display_name:string}|null $user
 */
function ebr_db_collab_user_can_write(array $batch, ?array $user): bool
{
    // No verifiable identity to check against — EBR_REQUIRE_LOGIN is off, or
    // EBR_LOGIN_BYPASS_DB is on and the session carries a synthetic id 0. Gating on membership
    // would lock everyone out of a deployment that has no real accounts to be a member of.
    if ($user === null || (int) ($user['id'] ?? 0) <= 0) {
        return true;
    }

    $userId = (int) ($user['id'] ?? 0);
    $creatorId = isset($batch['createdByUserId']) ? (int) $batch['createdByUserId'] : 0;
    if ($userId > 0 && $creatorId > 0 && $userId === $creatorId) {
        return true;
    }

    // Batches created before created_by_user_id existed only recorded a display name.
    if ($creatorId <= 0) {
        $creatorName = strtolower(trim((string) ($batch['createdBy'] ?? '')));
        if ($creatorName !== '') {
            foreach ([(string) ($user['display_name'] ?? ''), (string) ($user['username'] ?? '')] as $cand) {
                if ($creatorName === strtolower(trim($cand)) && trim($cand) !== '') {
                    return true;
                }
            }
        }
    }

    $batchId = (string) ($batch['id'] ?? '');
    if ($batchId === '' || $userId <= 0) {
        return false;
    }

    return ebr_db_collab_is_member($batchId, $userId);
}

// ─── Live Collab presence ───────────────────────────────────────────────────

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function ebr_db_presence_row_to_api(array $row): array
{
    return [
        'id' => (string) $row['id'],
        'batchId' => (string) $row['batch_id'],
        'dbUserId' => (int) $row['db_user_id'],
        'username' => (string) $row['username'],
        'displayName' => (string) ($row['display_name'] ?? ''),
        'verifiedAt' => ebr_db_ts_to_iso($row['verified_at'] ?? null),
        'expiresAt' => ebr_db_ts_to_iso($row['expires_at'] ?? null),
        'endedAt' => ebr_db_ts_to_iso($row['ended_at'] ?? null),
        'source' => ((string) ($row['source'] ?? 'password')) === 'session' ? 'session' : 'password',
    ];
}

/**
 * Record a successful credential verification. Any still-open window for the same person on
 * the same batch is closed first, so one person holds at most one live window per batch.
 *
 * @param array<string, mixed> $dbUserRow Row from db_user (already password-verified)
 * @param string $source 'password' when they re-entered credentials, 'session' when this is
 *                       the signed-in user, whose identity was proved at login
 * @return array<string, mixed> API-shaped presence row
 */
function ebr_db_presence_open(
    string $batchId,
    array $dbUserRow,
    int $minutes,
    ?string $ip,
    int $sessionUserId,
    string $source = 'password'
): array {
    $dbUserId = (int) ($dbUserRow['db_user_id'] ?? 0);
    if ($dbUserId <= 0) {
        throw new InvalidArgumentException('Presence requires a db_user_id');
    }

    $pdo = ebr_pg_pdo();
    $pdo->beginTransaction();
    try {
        $close = $pdo->prepare(
            'UPDATE ebr_batch_presence SET ended_at = NOW()
              WHERE batch_id = :b AND db_user_id = :u AND ended_at IS NULL AND expires_at > NOW()'
        );
        $close->execute(['b' => $batchId, 'u' => $dbUserId]);

        $id = uniqid('presence_', true);
        $ins = $pdo->prepare(
            "INSERT INTO ebr_batch_presence
                (id, batch_id, db_user_id, username, display_name, verified_at, expires_at,
                 verified_ip, verified_by_session_user_id, source)
             VALUES (:id, :b, :u, :un, :dn, NOW(), NOW() + (:mins || ' minutes')::interval,
                     :ip, :sid, :src)"
        );
        $ins->execute([
            'id' => $id,
            'b' => $batchId,
            'u' => $dbUserId,
            'un' => (string) ($dbUserRow['username'] ?? ''),
            'dn' => ebr_db_user_display_name($dbUserRow),
            'mins' => (string) $minutes,
            'ip' => $ip !== null && $ip !== '' ? $ip : null,
            'sid' => $sessionUserId > 0 ? $sessionUserId : null,
            'src' => $source === 'session' ? 'session' : 'password',
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }

    $row = ebr_db_presence_fetch($id);
    if ($row === null) {
        throw new RuntimeException('Presence row vanished after insert');
    }

    return $row;
}

/**
 * @return array<string, mixed>|null
 */
function ebr_db_presence_fetch(string $presenceId): ?array
{
    if (trim($presenceId) === '') {
        return null;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT * FROM ebr_batch_presence WHERE id = :id LIMIT 1');
    $st->execute(['id' => $presenceId]);
    $row = $st->fetch(PDO::FETCH_ASSOC);

    return $row ? ebr_db_presence_row_to_api($row) : null;
}

/**
 * Currently valid presence windows for a batch (not ended, not expired).
 *
 * @return list<array<string, mixed>>
 */
function ebr_db_presence_active(string $batchId): array
{
    if (trim($batchId) === '') {
        return [];
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'SELECT * FROM ebr_batch_presence
          WHERE batch_id = :b AND ended_at IS NULL AND expires_at > NOW()
          ORDER BY verified_at DESC'
    );
    $st->execute(['b' => $batchId]);

    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_presence_row_to_api($row);
    }

    return $out;
}

/**
 * End a presence window early ("step away"). Only the window's own owner or the batch's
 * session user should be allowed to call this; the endpoint enforces that.
 */
function ebr_db_presence_end(string $presenceId): bool
{
    if (trim($presenceId) === '') {
        return false;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('UPDATE ebr_batch_presence SET ended_at = NOW() WHERE id = :id AND ended_at IS NULL');
    $st->execute(['id' => $presenceId]);

    return $st->rowCount() > 0;
}

/**
 * Does this presence window justify attributing an entry to $dbUserId on $batchId at $atIso?
 *
 * This is the check that makes per-field attribution evidence rather than a claim: the client
 * says "user X recorded this at T under presence P", and the server confirms P was X's own
 * verified window on this batch and that T falls inside it.
 */
function ebr_db_presence_covers(string $presenceId, string $batchId, int $dbUserId, string $atIso): bool
{
    $p = ebr_db_presence_fetch($presenceId);
    if ($p === null) {
        return false;
    }
    if ($p['batchId'] !== $batchId || $p['dbUserId'] !== $dbUserId) {
        return false;
    }

    $at = strtotime($atIso);
    $from = strtotime((string) $p['verifiedAt']);
    $until = strtotime((string) $p['expiresAt']);
    if ($at === false || $from === false || $until === false) {
        return false;
    }
    if ($p['endedAt'] !== null) {
        $ended = strtotime((string) $p['endedAt']);
        if ($ended !== false && $ended < $until) {
            $until = $ended;
        }
    }

    // Small tolerance for clock skew between the browser clock that stamped the entry
    // and the database clock that stamped the window.
    $skew = 120;

    return $at >= ($from - $skew) && $at <= ($until + $skew);
}

/**
 * Give the signed-in user a presence window on a batch they collaborate on, without asking for
 * their password again — they proved who they are at login. Other collaborators at the same
 * machine still verify through collab-verify.php.
 *
 * No-op when they are not a collaborator, or already hold an open window.
 *
 * @param array{id:int, username:string, display_name:string}|null $sessionUser
 */
function ebr_db_presence_ensure_session(string $batchId, ?array $sessionUser, int $minutes): void
{
    if ($sessionUser === null) {
        return;
    }
    $userId = (int) ($sessionUser['id'] ?? 0);
    if ($userId <= 0 || !ebr_db_collab_is_member($batchId, $userId)) {
        return;
    }

    foreach (ebr_db_presence_active($batchId) as $p) {
        if ((int) $p['dbUserId'] === $userId) {
            return;
        }
    }

    try {
        $row = ebr_db_user_fetch_by_id($userId);
    } catch (Throwable $e) {
        error_log('ebr presence ensure_session: ' . $e->getMessage());

        return;
    }
    if ($row === null || ebr_db_user_is_disabled($row)) {
        return;
    }

    try {
        ebr_db_presence_open($batchId, $row, $minutes, $_SERVER['REMOTE_ADDR'] ?? null, $userId, 'session');
    } catch (Throwable $e) {
        error_log('ebr presence ensure_session open: ' . $e->getMessage());
    }
}
