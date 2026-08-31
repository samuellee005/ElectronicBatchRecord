<?php
/**
 * Live Collab — verify a collaborator's own credentials so entries can be attributed to them.
 *
 * POST { batchId, username, password } → { presence: {...} }
 *
 * This does NOT change who is logged in: $_SESSION['ebr_user'] is untouched. It records a
 * presence window in ebr_batch_presence proving that this person was physically at the
 * machine and proved their identity at that moment.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/batch-record.php';
require_once __DIR__ . '/db-batch-collab.php';
require_once __DIR__ . '/db-db-user.php';

header('Content-Type: application/json');

/** Throttle window for failed verification attempts, per session. */
const EBR_COLLAB_MAX_FAILURES = 5;
const EBR_COLLAB_LOCKOUT_SECONDS = 300;

function ebr_collab_verify_fail(string $message, int $status = 200, ?string $code = null): void
{
    if ($status !== 200) {
        http_response_code($status);
    }
    $out = ['success' => false, 'message' => $message];
    if ($code !== null) {
        $out['code'] = $code;
    }
    echo json_encode($out);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    ebr_collab_verify_fail('POST required');
}

// Verifying a password is meaningless where logins do not check one — recording a presence
// attestation in that configuration would be worse than recording nothing.
if (!ebr_collab_verification_available()) {
    ebr_collab_verify_fail(
        'Live Collab needs real password checking. Set EBR_REQUIRE_PASSWORD=1 and leave '
        . 'EBR_LOGIN_BYPASS_DB unset on this deployment.',
        200,
        'verification_unavailable'
    );
}

$raw = json_decode((string) file_get_contents('php://input'), true);
if (!is_array($raw)) {
    ebr_collab_verify_fail('Invalid JSON');
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', (string) ($raw['batchId'] ?? ''));
$username = trim((string) ($raw['username'] ?? ''));
$password = (string) ($raw['password'] ?? '');

if ($batchId === '') {
    ebr_collab_verify_fail('Missing batchId');
}
if ($username === '' || $password === '') {
    ebr_collab_verify_fail('Username and password are both required.');
}

// Per-session throttle so this endpoint cannot be used to guess colleagues' passwords.
$now = time();
$fails = $_SESSION['ebr_collab_failures'] ?? [];
$fails = array_values(array_filter(
    is_array($fails) ? $fails : [],
    static fn ($t) => is_int($t) && ($now - $t) < EBR_COLLAB_LOCKOUT_SECONDS
));
if (count($fails) >= EBR_COLLAB_MAX_FAILURES) {
    $_SESSION['ebr_collab_failures'] = $fails;
    $wait = (int) ceil((EBR_COLLAB_LOCKOUT_SECONDS - ($now - $fails[0])) / 60);
    ebr_collab_verify_fail(
        'Too many failed verification attempts. Try again in about ' . max(1, $wait) . ' minute(s).',
        429,
        'throttled'
    );
}

$recordFailure = static function () use (&$fails, $now): void {
    $fails[] = $now;
    $_SESSION['ebr_collab_failures'] = $fails;
};

try {
    $batch = ebr_db_batch_fetch_by_id($batchId);
} catch (Throwable $e) {
    error_log('ebr collab-verify: ' . $e->getMessage());
    ebr_collab_verify_fail('Could not read the batch record.', 500);
}
if ($batch === null) {
    ebr_collab_verify_fail('Batch record not found');
}
if (($batch['status'] ?? '') === 'completed') {
    ebr_collab_verify_fail('This batch is complete; no further data can be recorded.');
}

try {
    $userRow = ebr_db_user_fetch_by_username($username);
} catch (Throwable $e) {
    error_log('ebr collab-verify lookup: ' . $e->getMessage());
    ebr_collab_verify_fail('Verification unavailable.', 500);
}

// Same message for unknown user and wrong password, so this cannot enumerate accounts.
if ($userRow === null || !ebr_db_user_verify_password($password, $userRow['password'] ?? null)) {
    $recordFailure();
    ebr_collab_verify_fail('Those credentials were not recognised.', 200, 'invalid_credentials');
}
if (ebr_db_user_is_disabled($userRow)) {
    $recordFailure();
    ebr_collab_verify_fail('That account is disabled in db_user.');
}

$dbUserId = (int) $userRow['db_user_id'];
if (!ebr_db_collab_is_member($batchId, $dbUserId)) {
    ebr_collab_verify_fail(
        ebr_db_user_display_name($userRow) . ' is not a collaborator on this batch. Add them to the batch first.',
        200,
        'not_a_collaborator'
    );
}

// Success — clear the throttle for this session.
unset($_SESSION['ebr_collab_failures']);

$minutes = ebr_collab_presence_minutes();
$ip = (string) ($_SERVER['REMOTE_ADDR'] ?? '');

try {
    $presence = ebr_db_presence_open($batchId, $userRow, $minutes, $ip, ebr_current_user_id());
} catch (Throwable $e) {
    error_log('ebr collab-verify presence: ' . $e->getMessage());
    ebr_collab_verify_fail('Could not record the verification.', 500);
}

echo json_encode([
    'success' => true,
    'presence' => $presence,
    'presenceMinutes' => $minutes,
]);
