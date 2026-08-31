<?php
/**
 * GET — enabled accounts from the enterprise `db_user` table, for the roster admin picker.
 * Read-only; never returns the password column.
 *
 * Query: ?q=<search> (optional, matches username/first/last/email)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-db-user.php';

header('Content-Type: application/json');

$q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';

try {
    $users = ebr_db_user_list_enabled($q);
} catch (Throwable $e) {
    error_log('ebr list-db-users: ' . $e->getMessage());
    echo json_encode([
        'success' => false,
        'message' => 'Could not read the db_user table on ' . ebr_pg_target_label() . '.',
        'users' => [],
    ]);
    exit;
}

echo json_encode(['success' => true, 'users' => $users]);
