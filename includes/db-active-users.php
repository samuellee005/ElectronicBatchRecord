<?php

declare(strict_types=1);

/**
 * PostgreSQL persistence for ebr_active_users (replaces data/active-users.json).
 */

require_once __DIR__ . '/db.php';

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function ebr_db_active_user_row_to_api(array $row): array
{
    $role = strtolower(trim((string) ($row['role'] ?? 'user')));

    $dbUserId = $row['db_user_id'] ?? null;
    $dbUserId = ($dbUserId === null || $dbUserId === '') ? null : (int) $dbUserId;

    return [
        'id' => (string) ($row['id'] ?? ''),
        'displayName' => trim((string) ($row['display_name'] ?? '')),
        'active' => !empty($row['active']),
        'role' => $role === 'admin' ? 'admin' : 'user',
        'dbUserId' => $dbUserId,
        'username' => trim((string) ($row['username'] ?? '')),
        // Only linked roster entries can be re-authenticated, so only they may be collaborators.
        'linked' => $dbUserId !== null,
    ];
}

/**
 * @return list<array<string, mixed>>
 */
function ebr_db_active_users_fetch_all(bool $activeOnly): array
{
    $pdo = ebr_pg_pdo();
    $sql = 'SELECT id, display_name, active, role, db_user_id, username, updated_at FROM ebr_active_users';
    if ($activeOnly) {
        $sql .= ' WHERE active = TRUE';
    }
    $sql .= ' ORDER BY display_name ASC';
    $st = $pdo->query($sql);
    $out = [];
    while ($row = $st->fetch(PDO::FETCH_ASSOC)) {
        $out[] = ebr_db_active_user_row_to_api($row);
    }

    return $out;
}

function ebr_db_active_users_count(): int
{
    $pdo = ebr_pg_pdo();
    $n = $pdo->query('SELECT COUNT(*)::int FROM ebr_active_users')->fetchColumn();

    return (int) $n;
}

/**
 * Replace the full user list (matches save-active-users.php contract).
 *
 * @param list<array{id: string, displayName: string, active: bool, role: string, dbUserId: int|null, username: string}> $users
 */
function ebr_db_active_users_replace_all(array $users): void
{
    $pdo = ebr_pg_pdo();
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM ebr_active_users');
        $st = $pdo->prepare(
            'INSERT INTO ebr_active_users (id, display_name, active, role, db_user_id, username, updated_at)
             VALUES (:id, :display_name, :active, :role, :db_user_id, :username, NOW())'
        );
        foreach ($users as $u) {
            $role = strtolower(trim((string) ($u['role'] ?? 'user')));
            if ($role !== 'admin') {
                $role = 'user';
            }
            $dbUserId = $u['dbUserId'] ?? null;
            $dbUserId = ($dbUserId === null || $dbUserId === '' || (int) $dbUserId <= 0) ? null : (int) $dbUserId;
            $st->execute([
                'id' => $u['id'],
                'display_name' => $u['displayName'],
                'active' => !empty($u['active']),
                'role' => $role,
                'db_user_id' => $dbUserId,
                'username' => trim((string) ($u['username'] ?? '')) ?: null,
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}

/**
 * Roster entry for a `db_user` account, or null when that account is not on the roster.
 * Used to validate collaborator selections — only linked, active roster entries qualify.
 *
 * @return array<string, mixed>|null
 */
function ebr_db_active_user_find_by_db_user_id(int $dbUserId): ?array
{
    if ($dbUserId <= 0) {
        return null;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'SELECT id, display_name, active, role, db_user_id, username, updated_at
         FROM ebr_active_users WHERE db_user_id = :i LIMIT 1'
    );
    $st->execute(['i' => $dbUserId]);
    $row = $st->fetch(PDO::FETCH_ASSOC);

    return $row ? ebr_db_active_user_row_to_api($row) : null;
}
