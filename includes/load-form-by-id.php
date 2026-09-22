<?php
/**
 * Load form configuration by ID (PostgreSQL ebr_forms)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/form-permissions.php';

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

    // Who may edit this form and who may change its access list; see
    // includes/form-permissions.php.
    $sessionUser = ebr_current_user();
    $isOwned = ebr_form_is_owned($foundForm);
    $canEdit = ebr_form_user_can_edit($foundForm, $sessionUser);
    $canManageAccess = ebr_form_user_can_manage_access($foundForm, $sessionUser);

    echo json_encode([
        'success' => true,
        'form' => $foundForm,
        'canEdit' => $canEdit,
        'canManageAccess' => $canManageAccess,
        'isOwned' => $isOwned,
        'roster' => ebr_form_roster($foundForm),
    ]);
} else {
    echo json_encode(['success' => false, 'message' => 'Form not found']);
}
