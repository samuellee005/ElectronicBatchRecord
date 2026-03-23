<?php
/**
 * Save form configuration with audit trail
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

// Validate user name for audit trail
if (empty($formData['userName'])) {
    echo json_encode(['success' => false, 'message' => 'User name is required for audit trail']);
    exit;
}

// Normalize version to one decimal place to avoid float drift (e.g. 1.2000000000000002 → 1.2)
function versionToDecimal($v) {
    return round(floatval($v), 1);
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
$oldFormConfig = null;

// Function to compare fields and generate audit trail
function compareFields($oldFields, $newFields, $userName) {
    $auditEntries = [];
    
    // Create maps for easier comparison
    $oldFieldsMap = [];
    foreach ($oldFields as $field) {
        $oldFieldsMap[$field['id']] = $field;
    }
    
    $newFieldsMap = [];
    foreach ($newFields as $field) {
        $newFieldsMap[$field['id']] = $field;
    }
    
    // Check for additions
    foreach ($newFieldsMap as $fieldId => $field) {
        if (!isset($oldFieldsMap[$fieldId])) {
            $auditEntries[] = [
                'type' => 'component_added',
                'componentId' => $fieldId,
                'componentName' => $field['label'] ?? 'Unnamed',
                'componentType' => $field['type'] ?? 'unknown',
                'user' => $userName,
                'timestamp' => date('c'),
                'details' => [
                    'position' => ['x' => $field['x'] ?? 0, 'y' => $field['y'] ?? 0],
                    'size' => ['width' => $field['width'] ?? 0, 'height' => $field['height'] ?? 0]
                ]
            ];
        }
    }
    
    // Check for removals
    foreach ($oldFieldsMap as $fieldId => $field) {
        if (!isset($newFieldsMap[$fieldId])) {
            $auditEntries[] = [
                'type' => 'component_removed',
                'componentId' => $fieldId,
                'componentName' => $field['label'] ?? 'Unnamed',
                'componentType' => $field['type'] ?? 'unknown',
                'user' => $userName,
                'timestamp' => date('c')
            ];
        }
    }
    
    // Check for modifications
    foreach ($newFieldsMap as $fieldId => $newField) {
        if (isset($oldFieldsMap[$fieldId])) {
            $oldField = $oldFieldsMap[$fieldId];
            $changes = [];
            
            // Check label/name changes
            if (($oldField['label'] ?? '') !== ($newField['label'] ?? '')) {
                $changes[] = [
                    'field' => 'name',
                    'old' => $oldField['label'] ?? '',
                    'new' => $newField['label'] ?? ''
                ];
            }
            
            // Check position changes
            $oldX = $oldField['x'] ?? 0;
            $oldY = $oldField['y'] ?? 0;
            $newX = $newField['x'] ?? 0;
            $newY = $newField['y'] ?? 0;
            
            if ($oldX !== $newX || $oldY !== $newY) {
                $changes[] = [
                    'field' => 'position',
                    'old' => ['x' => $oldX, 'y' => $oldY],
                    'new' => ['x' => $newX, 'y' => $newY]
                ];
            }
            
            // Check size changes
            $oldWidth = $oldField['width'] ?? 0;
            $oldHeight = $oldField['height'] ?? 0;
            $newWidth = $newField['width'] ?? 0;
            $newHeight = $newField['height'] ?? 0;
            
            if ($oldWidth !== $newWidth || $oldHeight !== $newHeight) {
                $changes[] = [
                    'field' => 'size',
                    'old' => ['width' => $oldWidth, 'height' => $oldHeight],
                    'new' => ['width' => $newWidth, 'height' => $newHeight]
                ];
            }
            
            // Check type changes
            if (($oldField['type'] ?? '') !== ($newField['type'] ?? '')) {
                $changes[] = [
                    'field' => 'type',
                    'old' => $oldField['type'] ?? '',
                    'new' => $newField['type'] ?? ''
                ];
            }
            
            // Check other property changes
            $propertiesToCheck = ['required', 'stageInProcess', 'stageOrder', 'page'];
            foreach ($propertiesToCheck as $prop) {
                $oldVal = $oldField[$prop] ?? null;
                $newVal = $newField[$prop] ?? null;
                if ($oldVal !== $newVal) {
                    $changes[] = [
                        'field' => $prop,
                        'old' => $oldVal,
                        'new' => $newVal
                    ];
                }
            }
            
            if (!empty($changes)) {
                $auditEntries[] = [
                    'type' => 'component_modified',
                    'componentId' => $fieldId,
                    'componentName' => $newField['label'] ?? 'Unnamed',
                    'componentType' => $newField['type'] ?? 'unknown',
                    'user' => $userName,
                    'timestamp' => date('c'),
                    'changes' => $changes
                ];
            }
        }
    }
    
    return $auditEntries;
}

// Function to generate initial audit trail for new form
function generateInitialAuditTrail($fields, $userName) {
    $auditEntries = [];
    
    foreach ($fields as $field) {
        $auditEntries[] = [
            'type' => 'component_added',
            'componentId' => $field['id'] ?? uniqid('field_'),
            'componentName' => $field['label'] ?? 'Unnamed',
            'componentType' => $field['type'] ?? 'unknown',
            'user' => $userName,
            'timestamp' => date('c'),
            'details' => [
                'position' => ['x' => $field['x'] ?? 0, 'y' => $field['y'] ?? 0],
                'size' => ['width' => $field['width'] ?? 0, 'height' => $field['height'] ?? 0]
            ]
        ];
    }
    
    return $auditEntries;
}

if ($isUpdate && !$isNewVersion) {
    // Update existing form - find the form file
    $forms = glob($formsDir . '/*.json');
    foreach ($forms as $formFile) {
        $existingForm = json_decode(file_get_contents($formFile), true);
        if ($existingForm && isset($existingForm['id']) && $existingForm['id'] === $formData['formId']) {
            $filepath = $formFile;
            $formConfig = $existingForm;
            $oldFormConfig = json_decode(json_encode($existingForm), true); // Deep copy
            break;
        }
    }

    if (!$filepath || !$formConfig) {
        echo json_encode(['success' => false, 'message' => 'Form not found for update']);
        exit;
    }

    // Check if PDF changed (major version bump)
    $pdfChanged = ($formConfig['pdfFile'] !== $formData['pdfFile']);
    
    if ($pdfChanged) {
        // PDF changed - create new major version (1.0 → 2.0)
        $oldVersion = versionToDecimal($formConfig['version'] ?? 1.0);
        $newVersion = versionToDecimal(floor($oldVersion) + 1.0); // 1.0 → 2.0, 1.5 → 2.0, etc.
        
        // Create new file for new major version
        $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);
        $filename = $sanitizedName . '_v' . number_format($newVersion, 1) . '_' . time() . '.json';
        $filepath = $formsDir . '/' . $filename;
        
        // Generate audit trail for PDF change
        $auditTrail = $formConfig['auditTrail'] ?? [];
        $auditTrail[] = [
            'type' => 'pdf_changed',
            'oldPdf' => $formConfig['pdfFile'],
            'newPdf' => $formData['pdfFile'],
            'user' => $formData['userName'],
            'timestamp' => date('c'),
            'versionChange' => $oldVersion . ' → ' . number_format($newVersion, 1)
        ];
        
        // Also generate audit trail for initial components
        $initialAudit = generateInitialAuditTrail($formData['fields'] ?? [], $formData['userName']);
        $auditTrail = array_merge($auditTrail, $initialAudit);
        
        $formConfig = [
            'id' => uniqid('form_'),
            'name' => $formData['name'],
            'description' => $formData['description'] ?? '',
            'pdfFile' => $formData['pdfFile'],
            'fields' => $formData['fields'] ?? [],
            'version' => $newVersion,
            'isLatest' => true,
            'sourceFormIds' => $formData['sourceFormIds'] ?? [],
            'isCombined' => isset($formData['isCombined']) && $formData['isCombined'] === true,
            'createdAt' => $formConfig['createdAt'] ?? date('c'),
            'updatedAt' => date('c'),
            'auditTrail' => $auditTrail,
            'createdBy' => $formConfig['createdBy'] ?? $formData['userName'],
            'updatedBy' => $formData['userName']
        ];
        
        // Mark old version as not latest
        $oldFormConfig['isLatest'] = false;
        $oldFilepath = null;
        $forms = glob($formsDir . '/*.json');
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm && isset($existingForm['id']) && $existingForm['id'] === $formData['formId']) {
                $oldFilepath = $formFile;
                break;
            }
        }
        if ($oldFilepath) {
            file_put_contents($oldFilepath, json_encode($oldFormConfig, JSON_PRETTY_PRINT));
        }
        
    } else {
        // Same template - create new minor version (1.0 → 1.1 → 1.2 → …). Use max version
        // among all forms with this name + template so repeated saves from the same opened
        // form still increment (1.1, 1.2, 1.3), not stuck at 1.1.
        $sameNameAndPdfVersions = [versionToDecimal($formConfig['version'] ?? 1.0)];
        foreach (glob($formsDir . '/*.json') as $f) {
            $existingForm = json_decode(file_get_contents($f), true);
            if ($existingForm &&
                isset($existingForm['name'], $existingForm['pdfFile']) &&
                $existingForm['name'] === $formData['name'] &&
                $existingForm['pdfFile'] === $formData['pdfFile']) {
                $sameNameAndPdfVersions[] = versionToDecimal($existingForm['version'] ?? 1.0);
            }
        }
        $oldVersion = versionToDecimal($formConfig['version'] ?? 1.0);
        $newVersion = versionToDecimal(max($sameNameAndPdfVersions) + 0.1);
        
        // Create new file for new minor version
        $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);
        $filename = $sanitizedName . '_v' . number_format($newVersion, 1) . '_' . time() . '.json';
        $filepath = $formsDir . '/' . $filename;
        
        // Compare fields and generate audit trail
        $oldFields = $oldFormConfig['fields'] ?? [];
        $newFields = $formData['fields'] ?? [];
        $fieldChanges = compareFields($oldFields, $newFields, $formData['userName']);
        
        // Append to existing audit trail
        $auditTrail = $formConfig['auditTrail'] ?? [];
        $auditTrail = array_merge($auditTrail, $fieldChanges);
        
        // Add version change entry
        $auditTrail[] = [
            'type' => 'version_updated',
            'oldVersion' => number_format($oldVersion, 1),
            'newVersion' => number_format($newVersion, 1),
            'user' => $formData['userName'],
            'timestamp' => date('c'),
            'reason' => 'Field modifications'
        ];
        
        $formConfig = [
            'id' => uniqid('form_'),
            'name' => $formData['name'],
            'description' => $formData['description'] ?? '',
            'pdfFile' => $formData['pdfFile'],
            'fields' => $formData['fields'] ?? [],
            'version' => $newVersion,
            'isLatest' => true,
            'sourceFormIds' => $formData['sourceFormIds'] ?? [],
            'isCombined' => isset($formData['isCombined']) && $formData['isCombined'] === true,
            'createdAt' => $formConfig['createdAt'] ?? date('c'),
            'updatedAt' => date('c'),
            'auditTrail' => $auditTrail,
            'createdBy' => $formConfig['createdBy'] ?? $formData['userName'],
            'updatedBy' => $formData['userName']
        ];
        
        // Mark old version as not latest
        $oldFormConfig['isLatest'] = false;
        $oldFilepath = null;
        $forms = glob($formsDir . '/*.json');
        foreach ($forms as $formFile) {
            $existingForm = json_decode(file_get_contents($formFile), true);
            if ($existingForm && isset($existingForm['id']) && $existingForm['id'] === $formData['formId']) {
                $oldFilepath = $formFile;
                break;
            }
        }
        if ($oldFilepath) {
            file_put_contents($oldFilepath, json_encode($oldFormConfig, JSON_PRETTY_PRINT));
        }
    }

} else {
    // Create new form or new version
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);

    // Version logic: same form name + same template (pdfFile) → minor bump (1.0 → 1.1);
    // same form name + different template → major bump (1.0 → 2.0).
    $version = 1.0;
    $forms = glob($formsDir . '/*.json');
    $sameNameAndPdf = [];  // same name and same template (pdfFile)
    $sameNameOnly = [];    // same name, any template
    foreach ($forms as $formFile) {
        $existingForm = json_decode(file_get_contents($formFile), true);
        if (!$existingForm || !isset($existingForm['name']) || $existingForm['name'] !== $formData['name']) {
            continue;
        }
        $sameNameOnly[] = $existingForm;
        if (isset($existingForm['pdfFile']) && $existingForm['pdfFile'] === $formData['pdfFile']) {
            $sameNameAndPdf[] = $existingForm;
        }
    }

    if (!empty($sameNameAndPdf)) {
        // Same template for this form name → minor increment (e.g. v1.0 → v1.1)
        $versions = array_map(function($f) {
            return versionToDecimal($f['version'] ?? 1.0);
        }, $sameNameAndPdf);
        $version = versionToDecimal(max($versions) + 0.1);
    } elseif (!empty($sameNameOnly)) {
        // Different template but same form name → major version (e.g. v1.0 → v2.0)
        $versions = array_map(function($f) {
            return versionToDecimal($f['version'] ?? 1.0);
        }, $sameNameOnly);
        $maxVer = max($versions);
        $version = versionToDecimal(floor($maxVer) + 1.0);
    }

    $filename = $sanitizedName . '_v' . number_format($version, 1) . '_' . time() . '.json';
    $filepath = $formsDir . '/' . $filename;

    // Generate initial audit trail
    $auditTrail = generateInitialAuditTrail($formData['fields'] ?? [], $formData['userName']);

    $formConfig = [
        'id' => uniqid('form_'),
        'name' => $formData['name'],
        'description' => $formData['description'] ?? '',
        'pdfFile' => $formData['pdfFile'],
        'fields' => $formData['fields'] ?? [],
        'version' => $version,
        'isLatest' => true,
        'sourceFormIds' => $formData['sourceFormIds'] ?? [],
        'isCombined' => isset($formData['isCombined']) && $formData['isCombined'] === true,
        'createdAt' => $formData['createdAt'] ?? date('c'),
        'updatedAt' => date('c'),
        'auditTrail' => $auditTrail,
        'createdBy' => $formData['userName'],
        'updatedBy' => $formData['userName']
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
        'version' => versionToDecimal($formConfig['version'])
    ]);
} else {
    echo json_encode(['success' => false, 'message' => 'Failed to save form']);
}
