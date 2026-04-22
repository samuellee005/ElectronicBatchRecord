<?php

declare(strict_types=1);

/**
 * Read-only access to enterprise PostgreSQL table `db_user` (see database/db_user.sql).
 * This application must not INSERT, UPDATE, or DELETE `db_user` rows or change passwords here.
 *
 * Role is not on the table: set EBR_ADMIN_USERNAMES=comma,separated,usernames for admin in the session UI.
 */

require_once __DIR__ . '/db.php';

function ebr_db_user_is_disabled(array $row): bool
{
    $d = strtoupper(trim((string) ($row['disabled'] ?? 'N')));

    return $d === 'Y';
}

/**
 * Verify password against stored value (bcrypt/argon, MD5 hex, or legacy plain text).
 */
function ebr_db_user_verify_password(string $plain, ?string $stored): bool
{
    if ($stored === null) {
        return false;
    }
    $stored = trim($stored);
    if ($stored === '') {
        return false;
    }
    // Modern PHP password_hash / crypt hashes
    if (str_starts_with($stored, '$2') || str_starts_with($stored, '$argon')) {
        return password_verify($plain, $stored);
    }
    // 32-char hex (common legacy MD5)
    if (strlen($stored) === 32 && ctype_xdigit($stored)) {
        $h = strtolower($stored);

        return hash_equals($h, md5($plain)) || hash_equals($h, md5(strtolower($plain)));
    }
    // Legacy cleartext (discouraged; match only exact stored string)
    return hash_equals($stored, $plain);
}

/**
 * @return array<string, mixed>|null
 */
function ebr_db_user_fetch_by_username(string $username): ?array
{
    $u = trim($username);
    if ($u === '') {
        return null;
    }
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'SELECT db_user_id, username, password, first_name, last_name, email, disabled
         FROM db_user WHERE LOWER(username) = LOWER(:u) LIMIT 1'
    );
    $st->execute(['u' => $u]);
    $row = $st->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

/**
 * @return array{id: int, username: string, display_name: string, role: string}
 */
/**
 * Session payload when EBR_LOGIN_BYPASS_DB=1 (no row from `db_user`).
 *
 * @return array{id: int, username: string, display_name: string, role: string}
 */
function ebr_db_user_synthetic_session_payload(string $username): array
{
    $u = trim($username);
    if ($u === '') {
        $u = 'user';
    }

    $role = 'user';
    $csv = getenv('EBR_ADMIN_USERNAMES');
    if ($csv !== false && $csv !== '') {
        $want = array_filter(array_map('trim', explode(',', strtolower($csv))));
        $un = strtolower($u);
        if ($un !== '' && in_array($un, $want, true)) {
            $role = 'admin';
        }
    }

    return [
        'id' => 0,
        'username' => $u,
        'display_name' => $u,
        'role' => $role,
    ];
}

function ebr_db_user_to_session_payload(array $row): array
{
    $fn = trim((string) ($row['first_name'] ?? ''));
    $ln = trim((string) ($row['last_name'] ?? ''));
    $display = trim($fn . ' ' . $ln);
    if ($display === '') {
        $display = (string) ($row['username'] ?? '');
    }

    $role = 'user';
    $csv = getenv('EBR_ADMIN_USERNAMES');
    if ($csv !== false && $csv !== '') {
        $want = array_filter(array_map('trim', explode(',', strtolower($csv))));
        $un = strtolower(trim((string) ($row['username'] ?? '')));
        if ($un !== '' && in_array($un, $want, true)) {
            $role = 'admin';
        }
    }

    return [
        'id' => (int) ($row['db_user_id'] ?? 0),
        'username' => (string) ($row['username'] ?? ''),
        'display_name' => $display,
        'role' => $role,
    ];
}
