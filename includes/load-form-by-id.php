<?php
/**
 * Load form configuration by ID
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

if (!isset($_GET['id'])) {
    echo json_encode(['success' => false, 'message' => 'Form ID not specified']);
    exit;
}

$formId = $_GET['id'];
$formsDir = FORMS_DIR;

if (!file_exists($formsDir)) {
    echo json_encode(['success' => false, 'message' => 'No forms directory']);
    exit;
}

// Find form by ID
$forms = glob($formsDir . '/*.json');
$foundForm = null;

foreach ($forms as $formFile) {
    $formData = json_decode(file_get_contents($formFile), true);
    if ($formData && isset($formData['id']) && $formData['id'] === $formId) {
        $foundForm = $formData;
        break;
    }
}

if ($foundForm) {
    // Ensure version and isLatest properties exist; normalize version to one decimal (e.g. 1.2 not 1.2000000000000002)
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
