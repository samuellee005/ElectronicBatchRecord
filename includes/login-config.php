<?php

/**
 * GET — JSON { "requirePassword": bool } for the login form (no session required).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/session.php';

header('Content-Type: application/json');
ebr_session_start();

$bypass = ebr_login_bypass_db_user();
$requirePassword = !$bypass && ebr_login_requires_password();
echo json_encode(
    [
        'requirePassword' => $requirePassword,
        'bypassDb' => $bypass,
    ],
    JSON_UNESCAPED_SLASHES
);
