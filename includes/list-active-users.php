<?php
/**
 * List active users for collaborator dropdowns.
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

if (!file_exists(ACTIVE_USERS_FILE)) {
    $default = [
        ['id' => 'user_' . uniqid(), 'displayName' => 'User One', 'active' => true],
        ['id' => 'user_' . uniqid(), 'displayName' => 'User Two', 'active' => true],
    ];
    file_put_contents(ACTIVE_USERS_FILE, json_encode($default, JSON_PRETTY_PRINT));
}

$raw = json_decode(file_get_contents(ACTIVE_USERS_FILE), true);
if (!is_array($raw)) {
    $raw = [];
}

$activeOnly = !isset($_GET['all']) || $_GET['all'] !== '1';
$out = [];
foreach ($raw as $u) {
    if (!is_array($u) || empty($u['id'])) {
        continue;
    }
    $row = [
        'id' => (string) $u['id'],
        'displayName' => trim((string) ($u['displayName'] ?? '')),
        'active' => !empty($u['active']),
    ];
    if ($row['displayName'] === '') {
        $row['displayName'] = $row['id'];
    }
    if ($activeOnly && !$row['active']) {
        continue;
    }
    $out[] = $row;
}

echo json_encode(['success' => true, 'users' => $out]);
