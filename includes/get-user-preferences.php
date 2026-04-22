<?php
/**
 * GET userKey — returns merged prefs JSON for that display-name key.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-user-preferences.php';

header('Content-Type: application/json');

$userKey = isset($_GET['userKey']) ? trim((string) $_GET['userKey']) : '';
if ($userKey === '') {
    echo json_encode(['success' => true, 'prefs' => new stdClass()]);
    exit;
}

try {
    $prefs = ebr_db_user_preferences_fetch($userKey);
} catch (Throwable $e) {
    error_log('ebr get-user-preferences: ' . $e->getMessage());
    echo json_encode(['success' => false, 'message' => 'Failed to load preferences', 'prefs' => new stdClass()]);
    exit;
}

echo json_encode(['success' => true, 'prefs' => $prefs]);
