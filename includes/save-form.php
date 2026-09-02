<?php
/**
 * Save form configuration with audit trail (PostgreSQL ebr_forms).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/db-forms.php';

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

if (empty($formData['name']) || empty($formData['pdfFile'])) {
    echo json_encode(['success' => false, 'message' => 'Missing required fields']);
    exit;
}

$sessionUser = ebr_current_user();
// Reliable attribution: prefer the authenticated user; fall back to a typed name
// only when there is no session (e.g. login not required on this deployment).
$typedName = trim((string) ($formData['userName'] ?? ''));
$actorName = $sessionUser && ($sessionUser['display_name'] !== '' || $sessionUser['username'] !== '')
    ? ($sessionUser['display_name'] !== '' ? $sessionUser['display_name'] : $sessionUser['username'])
    : $typedName;
$actorId = $sessionUser ? (int) $sessionUser['id'] : 0;
$actorUsername = $sessionUser
    ? strtolower((string) $sessionUser['username'])
    : strtolower($typedName);
if ($actorName === '') {
    echo json_encode(['success' => false, 'message' => 'User name is required for audit trail']);
    exit;
}

function versionToDecimal($v)
{
    return round(floatval($v), 1);
}

$isUpdate = !empty($formData['formId']);
$storageFilename = null;
$formConfig = null;
$isNewVersion = isset($formData['createNewVersion']) && $formData['createNewVersion'] === true;
$oldFormConfig = null;
$existingForm = null;

// Edit permission + save conflict for an existing form.
if ($isUpdate) {
    try {
        $existingForm = ebr_db_forms_fetch_by_id((string) $formData['formId']);
    } catch (Throwable $e) {
        $existingForm = null;
    }
    if ($existingForm) {
        $collabs = is_array($existingForm['collaborators'] ?? null) ? $existingForm['collaborators'] : [];
        $creatorUser = strtolower(trim((string) ($existingForm['createdBy'] ?? '')));
        $creatorId = (int) ($existingForm['createdByUserId'] ?? 0);
        // Only a VERIFIED creator (authenticated at save time) or explicit
        // collaborators make a form owned. Forms created before this feature carry
        // a self-reported name but no verified id, and stay open to everyone.
        $isOwned = $creatorId > 0 || !empty($collabs);
        // Unowned/legacy forms stay open; owned forms restrict to creator + collaborators.
        $allowed = !$isOwned;
        if ($actorUsername !== '' && $actorUsername === $creatorUser) {
            $allowed = true;
        }
        if ($actorId > 0 && $actorId === $creatorId) {
            $allowed = true;
        }
        foreach ($collabs as $c) {
            if (!is_array($c)) {
                continue;
            }
            $cu = strtolower(trim((string) ($c['username'] ?? '')));
            $cid = (int) ($c['dbUserId'] ?? 0);
            if (($actorUsername !== '' && $actorUsername === $cu) || ($actorId > 0 && $actorId === $cid)) {
                $allowed = true;
                break;
            }
        }
        if (!$allowed) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'code' => 'not_a_collaborator',
                'message' => 'You are not a collaborator on this form, so you cannot edit it.',
            ]);
            exit;
        }
        // Conflict: the version being edited is no longer the latest (someone saved since it was opened).
        if (!$isNewVersion && empty($existingForm['isLatest']) && empty($formData['force'])) {
            // Name whoever created the newer version.
            $latestBy = 'another user';
            try {
                foreach (ebr_db_forms_all_api() as $ef) {
                    if (!empty($ef['isLatest'])
                        && ($ef['name'] ?? '') === ($existingForm['name'] ?? '')
                        && ($ef['pdfFile'] ?? '') === ($existingForm['pdfFile'] ?? '')) {
                        $latestBy = $ef['updatedBy'] ?: $latestBy;
                        break;
                    }
                }
            } catch (Throwable $e) {
                // fall back to the generic name
            }
            http_response_code(409);
            echo json_encode([
                'success' => false,
                'code' => 'conflict',
                'message' => 'This form was changed by ' . $latestBy
                    . ' since you opened it. Reload to get their changes, or save as a new version.',
                'latestUpdatedBy' => $latestBy,
            ]);
            exit;
        }
    }
}

// Collaborators to store: an explicit list from the payload, else carry forward.
$collaboratorsToStore = [];
if (isset($formData['collaborators']) && is_array($formData['collaborators'])) {
    foreach ($formData['collaborators'] as $c) {
        if (!is_array($c)) {
            continue;
        }
        $u = trim((string) ($c['username'] ?? ''));
        $dn = trim((string) ($c['displayName'] ?? ''));
        $cid = (int) ($c['dbUserId'] ?? 0);
        if ($u === '' && $dn === '' && $cid <= 0) {
            continue;
        }
        $collaboratorsToStore[] = ['dbUserId' => $cid, 'username' => $u, 'displayName' => $dn];
    }
} elseif ($existingForm && is_array($existingForm['collaborators'] ?? null)) {
    $collaboratorsToStore = $existingForm['collaborators'];
}

function compareFields($oldFields, $newFields, $userName)
{
    $auditEntries = [];
    $oldFieldsMap = [];
    foreach ($oldFields as $field) {
        $oldFieldsMap[$field['id']] = $field;
    }
    $newFieldsMap = [];
    foreach ($newFields as $field) {
        $newFieldsMap[$field['id']] = $field;
    }
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
                    'size' => ['width' => $field['width'] ?? 0, 'height' => $field['height'] ?? 0],
                ],
            ];
        }
    }
    foreach ($oldFieldsMap as $fieldId => $field) {
        if (!isset($newFieldsMap[$fieldId])) {
            $auditEntries[] = [
                'type' => 'component_removed',
                'componentId' => $fieldId,
                'componentName' => $field['label'] ?? 'Unnamed',
                'componentType' => $field['type'] ?? 'unknown',
                'user' => $userName,
                'timestamp' => date('c'),
            ];
        }
    }
    foreach ($newFieldsMap as $fieldId => $newField) {
        if (isset($oldFieldsMap[$fieldId])) {
            $oldField = $oldFieldsMap[$fieldId];
            $changes = [];
            if (($oldField['label'] ?? '') !== ($newField['label'] ?? '')) {
                $changes[] = [
                    'field' => 'name',
                    'old' => $oldField['label'] ?? '',
                    'new' => $newField['label'] ?? '',
                ];
            }
            $oldX = $oldField['x'] ?? 0;
            $oldY = $oldField['y'] ?? 0;
            $newX = $newField['x'] ?? 0;
            $newY = $newField['y'] ?? 0;
            if ($oldX !== $newX || $oldY !== $newY) {
                $changes[] = [
                    'field' => 'position',
                    'old' => ['x' => $oldX, 'y' => $oldY],
                    'new' => ['x' => $newX, 'y' => $newY],
                ];
            }
            $oldWidth = $oldField['width'] ?? 0;
            $oldHeight = $oldField['height'] ?? 0;
            $newWidth = $newField['width'] ?? 0;
            $newHeight = $newField['height'] ?? 0;
            if ($oldWidth !== $newWidth || $oldHeight !== $newHeight) {
                $changes[] = [
                    'field' => 'size',
                    'old' => ['width' => $oldWidth, 'height' => $oldHeight],
                    'new' => ['width' => $newWidth, 'height' => $newHeight],
                ];
            }
            if (($oldField['type'] ?? '') !== ($newField['type'] ?? '')) {
                $changes[] = [
                    'field' => 'type',
                    'old' => $oldField['type'] ?? '',
                    'new' => $newField['type'] ?? '',
                ];
            }
            $propertiesToCheck = ['required', 'stageInProcess', 'stageOrder', 'page'];
            foreach ($propertiesToCheck as $prop) {
                $oldVal = $oldField[$prop] ?? null;
                $newVal = $newField[$prop] ?? null;
                if ($oldVal !== $newVal) {
                    $changes[] = ['field' => $prop, 'old' => $oldVal, 'new' => $newVal];
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
                    'changes' => $changes,
                ];
            }
        }
    }

    return $auditEntries;
}

function generateInitialAuditTrail($fields, $userName)
{
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
                'size' => ['width' => $field['width'] ?? 0, 'height' => $field['height'] ?? 0],
            ],
        ];
    }

    return $auditEntries;
}

try {
    $allForms = ebr_db_forms_all_api();
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Failed to load forms from database.']);
    exit;
}

if ($isUpdate && !$isNewVersion) {
    $formConfig = ebr_db_forms_fetch_by_id($formData['formId']);
    if (!$formConfig) {
        echo json_encode(['success' => false, 'message' => 'Form not found for update']);
        exit;
    }
    $oldFormConfig = json_decode(json_encode($formConfig), true);

    $pdfChanged = ($formConfig['pdfFile'] !== $formData['pdfFile']);

    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);

    if ($pdfChanged) {
        $oldVersion = versionToDecimal($formConfig['version'] ?? 1.0);
        $newVersion = versionToDecimal(floor($oldVersion) + 1.0);

        $storageFilename = $sanitizedName . '_v' . number_format($newVersion, 1) . '_' . time() . '.json';

        $auditTrail = $formConfig['auditTrail'] ?? [];
        $auditTrail[] = [
            'type' => 'pdf_changed',
            'oldPdf' => $formConfig['pdfFile'],
            'newPdf' => $formData['pdfFile'],
            'user' => $actorName,
            'timestamp' => date('c'),
            'versionChange' => $oldVersion . ' → ' . number_format($newVersion, 1),
        ];
        $auditTrail = array_merge($auditTrail, generateInitialAuditTrail($formData['fields'] ?? [], $actorName));

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
            'createdAt' => $oldFormConfig['createdAt'] ?? date('c'),
            'updatedAt' => date('c'),
            'auditTrail' => $auditTrail,
            'createdBy' => $oldFormConfig['createdBy'] ?? $actorName,
            'updatedBy' => $actorName,
        ];

        $oldFormConfig['isLatest'] = false;
    } else {
        $sameNameAndPdfVersions = [versionToDecimal($formConfig['version'] ?? 1.0)];
        foreach ($allForms as $existingForm) {
            if ($existingForm &&
                isset($existingForm['name'], $existingForm['pdfFile']) &&
                $existingForm['name'] === $formData['name'] &&
                $existingForm['pdfFile'] === $formData['pdfFile']) {
                $sameNameAndPdfVersions[] = versionToDecimal($existingForm['version'] ?? 1.0);
            }
        }
        $oldVersion = versionToDecimal($formConfig['version'] ?? 1.0);
        $newVersion = versionToDecimal(max($sameNameAndPdfVersions) + 0.1);

        $storageFilename = $sanitizedName . '_v' . number_format($newVersion, 1) . '_' . time() . '.json';

        $oldFields = $oldFormConfig['fields'] ?? [];
        $newFields = $formData['fields'] ?? [];
        $fieldChanges = compareFields($oldFields, $newFields, $actorName);

        $auditTrail = $formConfig['auditTrail'] ?? [];
        $auditTrail = array_merge($auditTrail, $fieldChanges);
        $auditTrail[] = [
            'type' => 'version_updated',
            'oldVersion' => number_format($oldVersion, 1),
            'newVersion' => number_format($newVersion, 1),
            'user' => $actorName,
            'timestamp' => date('c'),
            'reason' => 'Field modifications',
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
            'createdAt' => $oldFormConfig['createdAt'] ?? date('c'),
            'updatedAt' => date('c'),
            'auditTrail' => $auditTrail,
            'createdBy' => $oldFormConfig['createdBy'] ?? $actorName,
            'updatedBy' => $actorName,
        ];

        $oldFormConfig['isLatest'] = false;
    }
} else {
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);

    $version = 1.0;
    $sameNameAndPdf = [];
    $sameNameOnly = [];
    foreach ($allForms as $existingForm) {
        if (!$existingForm || !isset($existingForm['name']) || $existingForm['name'] !== $formData['name']) {
            continue;
        }
        $sameNameOnly[] = $existingForm;
        if (isset($existingForm['pdfFile']) && $existingForm['pdfFile'] === $formData['pdfFile']) {
            $sameNameAndPdf[] = $existingForm;
        }
    }

    if (!empty($sameNameAndPdf)) {
        $versions = array_map(function ($f) {
            return versionToDecimal($f['version'] ?? 1.0);
        }, $sameNameAndPdf);
        $version = versionToDecimal(max($versions) + 0.1);
    } elseif (!empty($sameNameOnly)) {
        $versions = array_map(function ($f) {
            return versionToDecimal($f['version'] ?? 1.0);
        }, $sameNameOnly);
        $maxVer = max($versions);
        $version = versionToDecimal(floor($maxVer) + 1.0);
    }

    $storageFilename = $sanitizedName . '_v' . number_format($version, 1) . '_' . time() . '.json';

    $auditTrail = generateInitialAuditTrail($formData['fields'] ?? [], $actorName);

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
        'createdBy' => $actorName,
        'updatedBy' => $actorName,
    ];

    if ($isNewVersion && !empty($formData['formId'])) {
        ebr_db_forms_mark_not_latest_same_name_pdf($formData['name'], $formData['pdfFile'], null);
    } else {
        ebr_db_forms_mark_not_latest_same_name_pdf($formData['name'], $formData['pdfFile'], $formConfig['id']);
    }
}

// Attribution + collaborators on the new row.
$formConfig['collaborators'] = $collaboratorsToStore;
$formConfig['updatedByUserId'] = $actorId > 0 ? $actorId : null;
$existingCreatorId = $existingForm ? (int) ($existingForm['createdByUserId'] ?? 0) : 0;
if ($existingCreatorId > 0) {
    // Keep the original verified creator on every later version.
    $formConfig['createdByUserId'] = $existingCreatorId;
} elseif (!$isUpdate || !empty($collaboratorsToStore)) {
    // A brand-new form, or a legacy form being given collaborators, becomes owned:
    // the person doing so is recorded as the verified creator so they keep access.
    $formConfig['createdByUserId'] = $actorId > 0 ? $actorId : null;
} else {
    // A legacy form edited without collaborators stays open to everyone.
    $formConfig['createdByUserId'] = null;
}

try {
    if ($isUpdate && !$isNewVersion) {
        ebr_db_forms_update_api($oldFormConfig, $oldFormConfig['storageFilename'] ?? null);
        ebr_db_forms_insert_api($formConfig, $storageFilename);
    } else {
        ebr_db_forms_insert_api($formConfig, $storageFilename);
    }
} catch (Throwable $e) {
    error_log('ebr save-form: ' . $e->getMessage());
    $show = getenv('EBR_SHOW_UPLOAD_ERRORS');
    if ($show !== false && $show !== '' && strtolower((string) $show) !== '0' && strtolower((string) $show) !== 'false') {
        echo json_encode(['success' => false, 'message' => 'Failed to save form to database.', 'detail' => $e->getMessage()]);
    } else {
        echo json_encode(['success' => false, 'message' => 'Failed to save form to database.']);
    }
    exit;
}

echo json_encode([
    'success' => true,
    'message' => $isNewVersion ? 'New version created successfully' : ($isUpdate ? 'Form updated successfully' : 'Form saved successfully'),
    'formId' => $formConfig['id'],
    'filename' => $storageFilename,
    'isUpdate' => $isUpdate,
    'isNewVersion' => $isNewVersion,
    'version' => versionToDecimal($formConfig['version']),
    'collaborators' => $collaboratorsToStore,
    'savedBy' => $actorName,
]);
