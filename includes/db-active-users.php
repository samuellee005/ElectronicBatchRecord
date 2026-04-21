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

    return [
        'id' => (string) ($row['id'] ?? ''),
        'displayName' => trim((string) ($row['display_name'] ?? '')),
        'active' => !empty($row['active']),
        'role' => $role === 'admin' ? 'admin' : 'user',
    ];
}

/**
 * @return list<array<string, mixed>>
 */
function ebr_db_active_users_fetch_all(bool $activeOnly): array
{
    $pdo = ebr_pg_pdo();
    $sql = 'SELECT id, display_name, active, role, updated_at FROM ebr_active_users';
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
 * @param list<array{id: string, displayName: string, active: bool, role: string}> $users
 */
function ebr_db_active_users_replace_all(array $users): void
{
    $pdo = ebr_pg_pdo();
    $pdo->beginTransaction();
    try {
        $pdo->exec('DELETE FROM ebr_active_users');
        $st = $pdo->prepare(
            'INSERT INTO ebr_active_users (id, display_name, active, role, updated_at)
             VALUES (:id, :display_name, :active, :role, NOW())'
        );
        foreach ($users as $u) {
            $role = strtolower(trim((string) ($u['role'] ?? 'user')));
            if ($role !== 'admin') {
                $role = 'user';
            }
            $st->execute([
                'id' => $u['id'],
                'display_name' => $u['displayName'],
                'active' => !empty($u['active']),
                'role' => $role,
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
}
