<?php

declare(strict_types=1);

/**
 * After config.php: start session and return 401 JSON if not logged in (when EBR_REQUIRE_LOGIN is on).
 */

require_once __DIR__ . '/session.php';

if (!ebr_api_requires_session()) {
    ebr_session_start();

    return;
}

ebr_session_start();

if (empty($_SESSION['ebr_user']) || !is_array($_SESSION['ebr_user'])) {
    http_response_code(401);
    header('Content-Type: application/json');
    echo json_encode([
        'success' => false,
        'message' => 'Not authenticated',
        'code' => 'auth_required',
    ]);
    exit;
}
