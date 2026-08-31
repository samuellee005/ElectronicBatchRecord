<?php
/**
 * Replace full active users list (PostgreSQL ebr_active_users).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-active-users.php';
require_once __DIR__ . '/db-db-user.php';

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
$seenDbUserIds = [];
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

    $displayName = trim((string) ($u['displayName'] ?? ''));
    $username = trim((string) ($u['username'] ?? ''));
    $dbUserId = isset($u['dbUserId']) && $u['dbUserId'] !== '' ? (int) $u['dbUserId'] : 0;

    // Resolve the link against db_user so the roster carries canonical identity, not typed text.
    // A roster entry with no valid link stays usable for display but cannot be a collaborator.
    if ($dbUserId > 0) {
        if (isset($seenDbUserIds[$dbUserId])) {
            echo json_encode([
                'success' => false,
                'message' => 'The same account is linked to more than one roster entry.',
            ]);
            exit;
        }
        try {
            $row = ebr_db_user_fetch_by_id($dbUserId);
        } catch (Throwable $e) {
            error_log('ebr save-active-users: ' . $e->getMessage());
            $row = null;
        }
        if ($row === null) {
            echo json_encode([
                'success' => false,
                'message' => 'Account #' . $dbUserId . ' was not found in db_user; remove or re-pick that roster entry.',
            ]);
            exit;
        }
        $seenDbUserIds[$dbUserId] = true;
        $username = (string) $row['username'];
        if ($displayName === '') {
            $displayName = ebr_db_user_display_name($row);
        }
    } else {
        $dbUserId = 0;
        $username = '';
    }

    $sanitized[] = [
        'id' => preg_replace('/[^a-zA-Z0-9_-]/', '_', $id) ?: 'user_' . uniqid(),
        'displayName' => $displayName !== '' ? $displayName : 'Unnamed',
        'active' => !empty($u['active']),
        'role' => $role,
        'dbUserId' => $dbUserId > 0 ? $dbUserId : null,
        'username' => $username,
    ];
}

try {
    ebr_db_active_users_replace_all($sanitized);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Failed to save']);
    exit;
}

echo json_encode(['success' => true, 'users' => $sanitized]);
