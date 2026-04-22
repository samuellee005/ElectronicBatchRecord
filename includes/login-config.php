<?php

/**
 * GET — JSON { "requirePassword": bool } for the login form (no session required).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/session.php';

header('Content-Type: application/json');
ebr_session_start();

echo json_encode(['requirePassword' => ebr_login_requires_password()], JSON_UNESCAPED_SLASHES);
