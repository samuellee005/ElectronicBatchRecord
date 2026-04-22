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
