<?php
/**
 * POST JSON { "username", "password?" } — sets PHP session on success.
 * Password is required only when EBR_REQUIRE_PASSWORD=1 (and not EBR_LOGIN_BYPASS_DB=1).
 * When EBR_LOGIN_BYPASS_DB=1 (e.g. dev server), any non-empty username is accepted; no `db_user` read.
 * Otherwise reads enterprise table `db_user` only (no writes to that table).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/db-db-user.php';

header('Content-Type: application/json');

ebr_session_start();

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'POST required']);
    exit;
}

$raw = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($raw)) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON']);
    exit;
}

$username = trim((string) ($raw['username'] ?? ''));
$password = (string) ($raw['password'] ?? '');
$bypassDb = ebr_login_bypass_db_user();
$requirePassword = !$bypassDb && ebr_login_requires_password();

if ($username === '') {
    echo json_encode(['success' => false, 'message' => 'Username is required']);
    exit;
}
if (strlen($username) > 200) {
    echo json_encode(['success' => false, 'message' => 'Username is too long.']);
    exit;
}

if ($bypassDb) {
    if (function_exists('session_regenerate_id')) {
        session_regenerate_id(true);
    }
    $_SESSION['ebr_user'] = ebr_db_user_synthetic_session_payload($username);
    $u = $_SESSION['ebr_user'];
    echo json_encode([
        'success' => true,
        'bypassDb' => true,
        'user' => [
            'id' => $u['id'],
            'username' => $u['username'],
            'displayName' => $u['display_name'],
            'role' => $u['role'],
        ],
    ]);
    exit;
}

if ($requirePassword && $password === '') {
    echo json_encode(['success' => false, 'message' => 'Password is required']);
    exit;
}

try {
    $row = ebr_db_user_fetch_by_username($username);
} catch (Throwable $e) {
    error_log('ebr login: ' . $e->getMessage());
    echo json_encode(['success' => false, 'message' => 'Login unavailable']);
    exit;
}

if ($row === null) {
    echo json_encode([
        'success' => false,
        'code' => 'user_not_found',
        'message' => 'That username was not found in the database (table db_user). The user must exist in the PostgreSQL database this EBR instance uses — check the spelling, and settings such as EBR_PG_DATABASE, EBR_DEPLOYMENT, and EBR_PG_HOST.',
    ]);
    exit;
}

if (ebr_db_user_is_disabled($row)) {
    echo json_encode([
        'success' => false,
        'code' => 'user_disabled',
        'message' => 'This account is disabled in db_user (disabled = Y).',
    ]);
    exit;
}

if ($requirePassword) {
    if (!ebr_db_user_verify_password($password, $row['password'] ?? null)) {
        echo json_encode(['success' => false, 'message' => 'Invalid username or password']);
        exit;
    }
}

if (function_exists('session_regenerate_id')) {
    session_regenerate_id(true);
}

$_SESSION['ebr_user'] = ebr_db_user_to_session_payload($row);

echo json_encode([
    'success' => true,
    'user' => [
        'id' => $_SESSION['ebr_user']['id'],
        'username' => $_SESSION['ebr_user']['username'],
        'displayName' => $_SESSION['ebr_user']['display_name'],
        'role' => $_SESSION['ebr_user']['role'],
    ],
]);
