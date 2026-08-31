<?php

declare(strict_types=1);

/**
 * PHP session for EBR login (cookie name EBRSESSID).
 */

function ebr_session_start(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
    if (PHP_VERSION_ID >= 70300) {
        session_set_cookie_params([
            'lifetime' => 0,
            'path' => '/',
            'domain' => '',
            'secure' => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
    } else {
        session_set_cookie_params(0, '/', '', $secure, true);
    }

    session_name('EBRSESSID');
    session_start();
}

/**
 * Whether API scripts should require a logged-in session.
 * Set EBR_REQUIRE_LOGIN=1 in production so APIs require a session (users are managed outside this app).
 * When unset or 0, APIs stay open for backwards compatibility.
 */
function ebr_api_requires_session(): bool
{
    $v = getenv('EBR_REQUIRE_LOGIN');
    if ($v === false || $v === '') {
        return false;
    }
    $s = strtolower(trim((string) $v));

    return $s === '1' || $s === 'true' || $s === 'yes' || $s === 'on';
}

/**
 * When true, /includes/login.php checks password against `db_user.password`.
 * Unset = username-only (testing; user must still exist in `db_user` and not be disabled).
 * Set EBR_REQUIRE_PASSWORD=1 in production before connecting to the main app auth.
 */
function ebr_login_requires_password(): bool
{
    $v = getenv('EBR_REQUIRE_PASSWORD');
    if ($v === false || $v === '') {
        return false;
    }
    $s = strtolower(trim((string) $v));

    return $s === '1' || $s === 'true' || $s === 'yes' || $s === 'on';
}

/**
 * When true, login accepts any non-empty username without reading `db_user`
 * (no PostgreSQL user table required). Intended for the dev server; when you go live, leave
 * this unset and sign in using the real `db_user` table.
 */
function ebr_login_bypass_db_user(): bool
{
    $v = getenv('EBR_LOGIN_BYPASS_DB');
    if ($v === false || $v === '') {
        return false;
    }
    $s = strtolower(trim((string) $v));

    return $s === '1' || $s === 'true' || $s === 'yes' || $s === 'on';
}

/**
 * Current logged-in user from the session, or null.
 *
 * @return array{id:int, username:string, display_name:string, role:string}|null
 */
function ebr_current_user(): ?array
{
    if (empty($_SESSION['ebr_user']) || !is_array($_SESSION['ebr_user'])) {
        return null;
    }
    $u = $_SESSION['ebr_user'];

    return [
        'id' => (int) ($u['id'] ?? 0),
        'username' => (string) ($u['username'] ?? ''),
        'display_name' => (string) ($u['display_name'] ?? ''),
        'role' => (string) ($u['role'] ?? 'user'),
    ];
}

/**
 * Session user id, or 0 when not logged in (EBR_REQUIRE_LOGIN off).
 */
function ebr_current_user_id(): int
{
    $u = ebr_current_user();

    return $u === null ? 0 : $u['id'];
}

function ebr_current_username(): string
{
    $u = ebr_current_user();

    return $u === null ? '' : $u['username'];
}

/**
 * Display name for the session user, falling back to the username.
 */
function ebr_current_display_name(): string
{
    $u = ebr_current_user();
    if ($u === null) {
        return '';
    }
    $d = trim($u['display_name']);

    return $d !== '' ? $d : $u['username'];
}

/**
 * Lifetime of a Live Collab presence verification, in minutes (fixed window, no sliding
 * extension). Override with EBR_COLLAB_PRESENCE_MINUTES; clamped to 1..480.
 */
function ebr_collab_presence_minutes(): int
{
    $v = getenv('EBR_COLLAB_PRESENCE_MINUTES');
    $n = ($v === false || trim((string) $v) === '') ? 30 : (int) trim((string) $v);
    if ($n < 1) {
        $n = 1;
    }
    if ($n > 480) {
        $n = 480;
    }

    return $n;
}

/**
 * Live Collab verification is only meaningful when logins actually check a password.
 * With EBR_LOGIN_BYPASS_DB=1 or EBR_REQUIRE_PASSWORD off, "verifying" a collaborator would
 * accept anyone, so the endpoint refuses rather than recording a worthless attestation.
 */
function ebr_collab_verification_available(): bool
{
    return !ebr_login_bypass_db_user() && ebr_login_requires_password();
}
