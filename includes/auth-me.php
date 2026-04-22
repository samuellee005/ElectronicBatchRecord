<?php
/**
 * GET — current session user or success:false.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/session.php';

header('Content-Type: application/json');

ebr_session_start();

if (!empty($_SESSION['ebr_user']) && is_array($_SESSION['ebr_user'])) {
    $u = $_SESSION['ebr_user'];
    echo json_encode([
        'success' => true,
        'authenticated' => true,
        'user' => [
            'id' => $u['id'],
            'username' => $u['username'],
            'displayName' => $u['display_name'],
            'role' => $u['role'],
        ],
    ]);
    exit;
}

echo json_encode(['success' => true, 'authenticated' => false, 'user' => null]);
