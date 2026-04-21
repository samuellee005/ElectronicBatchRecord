<?php
/**
 * Replace full active users list (PostgreSQL ebr_active_users).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-active-users.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid method']);
    exit;
}

$input = json_decode(file_get_contents('php://input'), true);
if (!$input || !isset($input['users']) || !is_array($input['users'])) {
    echo json_encode(['success' => false, 'message' => 'Missing users array']);
    exit;
}

$sanitized = [];
$seen = [];
foreach ($input['users'] as $u) {
    if (!is_array($u)) {
        continue;
    }
    $id = trim((string) ($u['id'] ?? ''));
    if ($id === '') {
        $id = 'user_' . uniqid();
    }
    if (isset($seen[$id])) {
        $id = $id . '_' . uniqid();
    }
    $seen[$id] = true;
    $roleRaw = isset($u['role']) ? strtolower(trim((string) $u['role'])) : '';
    $role = ($roleRaw === 'admin') ? 'admin' : 'user';
    $sanitized[] = [
        'id' => preg_replace('/[^a-zA-Z0-9_-]/', '_', $id) ?: 'user_' . uniqid(),
        'displayName' => trim((string) ($u['displayName'] ?? '')) ?: 'Unnamed',
        'active' => !empty($u['active']),
        'role' => $role,
    ];
}

try {
    ebr_db_active_users_replace_all($sanitized);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Failed to save']);
    exit;
}

echo json_encode(['success' => true, 'users' => $sanitized]);
