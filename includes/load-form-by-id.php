<?php
/**
 * Load form configuration by ID (PostgreSQL ebr_forms)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-forms.php';

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
    echo json_encode(['success' => true, 'form' => $foundForm]);
} else {
    echo json_encode(['success' => false, 'message' => 'Form not found']);
}
