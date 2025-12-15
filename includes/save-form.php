<?php
/**
 * Save form configuration
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request method']);
    exit;
}

$input = file_get_contents('php://input');
$formData = json_decode($input, true);

if (!$formData) {
    echo json_encode(['success' => false, 'message' => 'Invalid JSON data']);
    exit;
}

// Validate required fields
if (empty($formData['name']) || empty($formData['pdfFile'])) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

// Use forms directory from config
$formsDir = FORMS_DIR;
if (!file_exists($formsDir)) {
    mkdir($formsDir, 0755, true);
    file_put_contents($formsDir . '.gitkeep', '');
}

$isUpdate = !empty($formData['formId']);
$filepath = null;
$formConfig = null;
$isNewVersion = isset($formData['createNewVersion']) && $formData['createNewVersion'] === true;

if ($isUpdate && !$isNewVersion) {
    // Update existing form - find the form file
    $forms = glob($formsDir . '/*.json');
    foreach ($forms as $formFile) {
        $existingForm = json_decode(file_get_contents($formFile), true);
        if ($existingForm && isset($existingForm['id']) && $existingForm['id'] === $formData['formId']) {
            $filepath = $formFile;
            $formConfig = $existingForm;
            break;
        }
    }

    if (!$filepath || !$formConfig) {
        echo json_encode(['success' => false, 'message' => 'Form not found for update']);
        exit;
    }

    // Update existing form
    $formConfig['name'] = $formData['name'];
    $formConfig['description'] = $formData['description'] ?? '';
    $formConfig['fields'] = $formData['fields'] ?? [];
    $formConfig['updatedAt'] = date('c');
    // Keep original createdAt and version

} else {
    // Create new form or new version
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);

    // Determine version number
    $version = 1;
    if ($isNewVersion && !empty($formData['formId'])) {
        // Find all forms with the same name to determine next version
        $forms = glob($formsDir . '/*.json');
        $sameNameForms = [];
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm &&
                isset($existingForm['name']) &&
                $existingForm['name'] === $formData['name'] &&
                isset($existingForm['pdfFile']) &&
                $existingForm['pdfFile'] === $formData['pdfFile']) {
                $sameNameForms[] = $existingForm;
            }
        }

        if (!empty($sameNameForms)) {
            $versions = array_map(function($f) {
                return isset($f['version']) ? $f['version'] : 1;
            }, $sameNameForms);
            $version = max($versions) + 1;
        }
    } else {
        // Check if form with same name exists (for new forms)
        $forms = glob($formsDir . '/*.json');
        $sameNameForms = [];
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm &&
                isset($existingForm['name']) &&
                $existingForm['name'] === $formData['name'] &&
                isset($existingForm['pdfFile']) &&
                $existingForm['pdfFile'] === $formData['pdfFile']) {
                $sameNameForms[] = $existingForm;
            }
        }

        if (!empty($sameNameForms)) {
            $versions = array_map(function($f) {
                return isset($f['version']) ? $f['version'] : 1;
            }, $sameNameForms);
            $version = max($versions) + 1;
        }
    }

    $filename = $sanitizedName . '_v' . $version . '_' . time() . '.json';
    $filepath = $formsDir . '/' . $filename;

    $formConfig = [
        'id' => uniqid('form_'),
        'name' => $formData['name'],
        'description' => $formData['description'] ?? '',
        'pdfFile' => $formData['pdfFile'],
        'fields' => $formData['fields'] ?? [],
        'version' => $version,
        'isLatest' => true, // New versions are always latest initially
        'createdAt' => $formData['createdAt'] ?? date('c'),
        'updatedAt' => date('c')
    ];

    // If creating new version, mark old versions as not latest
    if ($isNewVersion && !empty($formData['formId'])) {
        $forms = glob($formsDir . '/*.json');
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm &&
                isset($existingForm['name']) &&
                $existingForm['name'] === $formData['name'] &&
                isset($existingForm['pdfFile']) &&
                $existingForm['pdfFile'] === $formData['pdfFile']) {
                $existingForm['isLatest'] = false;
                file_put_contents($formFile, json_encode($existingForm, JSON_PRETTY_PRINT));
            }
        }
    } else {
        // Mark other versions of same form as not latest
        $forms = glob($formsDir . '/*.json');
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm &&
                isset($existingForm['name']) &&
                $existingForm['name'] === $formData['name'] &&
                isset($existingForm['pdfFile']) &&
                $existingForm['pdfFile'] === $formData['pdfFile'] &&
                isset($existingForm['id']) &&
                $existingForm['id'] !== $formConfig['id']) {
                $existingForm['isLatest'] = false;
                file_put_contents($formFile, json_encode($existingForm, JSON_PRETTY_PRINT));
            }
        }
    }
}

if (file_put_contents($filepath, json_encode($formConfig, JSON_PRETTY_PRINT))) {
    echo json_encode([
        'success' => true,
        'message' => $isNewVersion ? 'New version created successfully' : ($isUpdate ? 'Form updated successfully' : 'Form saved successfully'),
        'formId' => $formConfig['id'],
        'filename' => basename($filepath),
        'isUpdate' => $isUpdate,
        'isNewVersion' => $isNewVersion,
        'version' => $formConfig['version'] ?? 1
    ]);
} else {
    echo json_encode(['success' => false, 'message' => 'Failed to save form']);
}
