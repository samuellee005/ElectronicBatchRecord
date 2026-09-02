<?php
/**
 * Load form configuration by ID (PostgreSQL ebr_forms)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/session.php';

header('Content-Type: application/json');

if (!isset($_GET['id'])) {
    echo json_encode(['success' => false, 'message' => 'Form ID not specified']);
    exit;
}

$formId = $_GET['id'];

try {
    $foundForm = ebr_db_forms_fetch_by_id($formId);
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Form not found']);
    exit;
}

if ($foundForm) {
    if (!isset($foundForm['version'])) {
        $foundForm['version'] = 1.0;
    }
    $foundForm['version'] = round(floatval($foundForm['version']), 1);
    if (!isset($foundForm['isLatest'])) {
        $foundForm['isLatest'] = true;
    }

    // Whether the current user may edit this form (creator + collaborators only
    // once a form is owned; unowned/legacy forms stay open to everyone).
    $sessionUser = ebr_current_user();
    $actorId = $sessionUser ? (int) $sessionUser['id'] : 0;
    $actorUsername = $sessionUser ? strtolower((string) $sessionUser['username']) : '';
    $collabs = is_array($foundForm['collaborators'] ?? null) ? $foundForm['collaborators'] : [];
    $creatorUser = strtolower(trim((string) ($foundForm['createdBy'] ?? '')));
    $creatorId = (int) ($foundForm['createdByUserId'] ?? 0);
    // Only a verified creator id or explicit collaborators make a form owned;
    // pre-feature forms carry a name but no verified id and stay open.
    $isOwned = $creatorId > 0 || !empty($collabs);
    $canEdit = !$isOwned;
    if ($actorUsername !== '' && $actorUsername === $creatorUser) {
        $canEdit = true;
    }
    if ($actorId > 0 && $actorId === $creatorId) {
        $canEdit = true;
    }
    foreach ($collabs as $c) {
        if (!is_array($c)) {
            continue;
        }
        $cu = strtolower(trim((string) ($c['username'] ?? '')));
        $cid = (int) ($c['dbUserId'] ?? 0);
        if (($actorUsername !== '' && $actorUsername === $cu) || ($actorId > 0 && $actorId === $cid)) {
            $canEdit = true;
            break;
        }
    }

    echo json_encode([
        'success' => true,
        'form' => $foundForm,
        'canEdit' => $canEdit,
        'isOwned' => $isOwned,
    ]);
} else {
    echo json_encode(['success' => false, 'message' => 'Form not found']);
}
