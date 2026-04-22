<?php
/**
 * List active users for collaborator dropdowns (PostgreSQL ebr_active_users).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-active-users.php';

header('Content-Type: application/json');

if (!function_exists('ebr_normalize_active_user_role')) {
    /**
     * @param mixed $r
     * @return string 'admin'|'user'
     */
    function ebr_normalize_active_user_role($r)
    {
        $v = is_string($r) ? strtolower(trim($r)) : '';

        return ($v === 'admin') ? 'admin' : 'user';
    }
}

/**
 * One-time: import legacy JSON file, or seed defaults when the table is empty.
 */
function ebr_active_users_ensure_seeded(): void
{
    try {
        if (ebr_db_active_users_count() > 0) {
            return;
        }
    } catch (Throwable $e) {
        return;
    }

    $fromFile = [];
    if (defined('ACTIVE_USERS_FILE') && is_readable(ACTIVE_USERS_FILE)) {
        $raw = json_decode((string) file_get_contents(ACTIVE_USERS_FILE), true);
        if (is_array($raw)) {
            foreach ($raw as $u) {
                if (!is_array($u) || empty($u['id'])) {
                    continue;
                }
                $fromFile[] = [
                    'id' => (string) $u['id'],
                    'displayName' => trim((string) ($u['displayName'] ?? '')) ?: (string) $u['id'],
                    'active' => !empty($u['active']),
                    'role' => ebr_normalize_active_user_role($u['role'] ?? null),
                ];
            }
        }
    }

    if ($fromFile !== []) {
        try {
            ebr_db_active_users_replace_all($fromFile);
        } catch (Throwable $e) {
            // fall through to defaults
        }
        try {
            if (ebr_db_active_users_count() > 0) {
                return;
            }
        } catch (Throwable $e) {
            return;
        }
    }

    $defaults = [
        [
            'id' => 'user_' . uniqid(),
            'displayName' => 'User One',
            'active' => true,
            'role' => 'user',
        ],
        [
            'id' => 'user_' . uniqid(),
            'displayName' => 'User Two',
            'active' => true,
            'role' => 'user',
        ],
    ];
    try {
        ebr_db_active_users_replace_all($defaults);
    } catch (Throwable $e) {
        // ignore
    }
}

ebr_active_users_ensure_seeded();

$activeOnly = !isset($_GET['all']) || $_GET['all'] !== '1';

try {
    $rows = ebr_db_active_users_fetch_all($activeOnly);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Failed to load users', 'users' => []]);
    exit;
}

$out = [];
foreach ($rows as $row) {
    $row = [
        'id' => (string) ($row['id'] ?? ''),
        'displayName' => trim((string) ($row['displayName'] ?? '')),
        'active' => !empty($row['active']),
        'role' => ebr_normalize_active_user_role($row['role'] ?? null),
    ];
    if ($row['displayName'] === '') {
        $row['displayName'] = $row['id'];
    }
    $out[] = $row;
}

echo json_encode(['success' => true, 'users' => $out]);
