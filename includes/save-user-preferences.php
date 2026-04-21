<?php
/**
 * POST { "userKey": string, "prefs": object } — full replace for that user_key row.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-user-preferences.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid method']);
    exit;
}

$raw = (string) file_get_contents('php://input');
$data = json_decode($raw, false);
if (!is_object($data)) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON']);
    exit;
}

$userKey = isset($data->userKey) ? trim((string) $data->userKey) : '';
if ($userKey === '') {
    echo json_encode(['success' => false, 'message' => 'userKey required']);
    exit;
}

$prefsNode = $data->prefs ?? null;
if ($prefsNode === null) {
    echo json_encode(['success' => false, 'message' => 'prefs required']);
    exit;
}

$flags = JSON_UNESCAPED_UNICODE;
if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
    $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
}
$json = json_encode($prefsNode, $flags);
if ($json === false) {
    echo json_encode(['success' => false, 'message' => 'prefs encode failed']);
    exit;
}

try {
    ebr_db_user_preferences_save_json($userKey, $json);
} catch (Throwable $e) {
    error_log('ebr save-user-preferences: ' . $e->getMessage());
    echo json_encode(['success' => false, 'message' => 'Failed to save preferences']);
    exit;
}

echo json_encode(['success' => true]);
