<?php
/**
 * Save form configuration with audit trail (PostgreSQL ebr_forms).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/session.php';
require_once __DIR__ . '/db-forms.php';
require_once __DIR__ . '/db-db-user.php';
require_once __DIR__ . '/form-permissions.php';

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
if ($actorName === '') {
    echo json_encode(['success' => false, 'message' => 'User name is required for audit trail']);
    exit;
}

// Grouping categories (free text). The client always resends these (pre-filled
// when editing), so read straight from the payload.
$formCategories = [
    'department' => trim((string) ($formData['department'] ?? '')),
    'program' => trim((string) ($formData['program'] ?? '')),
    'formType' => trim((string) ($formData['formType'] ?? '')),
];

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
        // Owners and editors may save; unowned legacy forms stay open to
        // everyone. See includes/form-permissions.php.
        if (!ebr_form_user_can_edit($existingForm, $sessionUser)) {
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

// Access roster to store.
//
// Editing a form never rewrites its access list: that is what
// includes/form-collaborators.php is for, and a save would otherwise let an
// editor quietly drop the owners. An existing form therefore carries its stored
// roster forward untouched. A brand-new form takes the people picked while
// creating it (as editors) plus its creator as the first owner.
$collaboratorsToStore = [];
if ($existingForm) {
    $collaboratorsToStore = ebr_form_roster_for_storage(ebr_form_roster_all($existingForm));
} else {
    $seen = [];
    foreach (($formData['collaborators'] ?? []) as $c) {
        if (!is_array($c)) {
            continue;
        }
        $cid = (int) ($c['dbUserId'] ?? 0);
        if ($cid <= 0 || isset($seen[$cid])) {
            continue;
        }
        $userRow = ebr_db_user_fetch_by_id($cid);
        if ($userRow === null || ebr_db_user_is_disabled($userRow)) {
            continue;
        }
        $seen[$cid] = true;
        $collaboratorsToStore[] = [
            'dbUserId' => $cid,
            'username' => (string) ($userRow['username'] ?? ''),
            'displayName' => ebr_db_user_display_name($userRow),
            'role' => strtolower(trim((string) ($c['role'] ?? ''))) === EBR_FORM_ROLE_OWNER
                ? EBR_FORM_ROLE_OWNER
                : EBR_FORM_ROLE_EDITOR,
            'addedByUserId' => $actorId > 0 ? $actorId : null,
            'addedAt' => date('c'),
        ];
    }
    // The creator owns what they create, so there is always someone who can
    // grant access.
    if ($actorId > 0 && !isset($seen[$actorId])) {
        array_unshift($collaboratorsToStore, [
            'dbUserId' => $actorId,
            'username' => $sessionUser['username'] ?? '',
            'displayName' => $actorName,
            'role' => EBR_FORM_ROLE_OWNER,
            'addedByUserId' => $actorId,
            'addedAt' => date('c'),
        ]);
    } elseif ($actorId > 0) {
        foreach ($collaboratorsToStore as &$entry) {
            if ((int) $entry['dbUserId'] === $actorId) {
                $entry['role'] = EBR_FORM_ROLE_OWNER;
            }
        }
        unset($entry);
    }
}

/**
 * Comparable shape of a field's calculated-value config (formula, references,
 * on/off), or null when the field is not calculated. Only these keys count, so
 * key order or unrelated props never register as a change.
 */
function normalizeCalc($field)
{
    $calc = $field['calc'] ?? null;
    if (!is_array($calc) || empty($calc['enabled'])) {
        return null;
    }
    $refs = [];
    foreach (($calc['refs'] ?? []) as $r) {
        $refs[] = [(string)($r['token'] ?? ''), (string)($r['fieldId'] ?? '')];
    }
    return ['formula' => trim((string)($calc['formula'] ?? '')), 'refs' => $refs];
}

/**
 * Readable summary of a field's calc config for the audit trail, with each
 * reference named by the label it had in the same form version:
 * "A + B (A = Mass, B = Volume)", or "Off".
 */
function describeCalc($field, $fieldsMap)
{
    $calc = normalizeCalc($field);
    if ($calc === null) {
        return 'Off';
    }
    $names = [];
    foreach ($calc['refs'] as [$token, $fieldId]) {
        $label = $fieldId === '' ? '(unset)' : ($fieldsMap[$fieldId]['label'] ?? '(deleted field)');
        $names[] = $token . ' = ' . $label;
    }
    $formula = $calc['formula'] !== '' ? $calc['formula'] : '(no formula)';
    return $names ? $formula . ' (' . implode(', ', $names) . ')' : $formula;
}

/**
 * Stage name => whether it must be completed before later stages. Mirrors
 * isStageGate in frontend/src/utils/stageSettings.js: the setting lives on
 * every field of the stage, and a stage counts as required unless all of its
 * fields say `stageRequired: false` (forms saved before the setting existed
 * have none, and always gated).
 */
function stageGates($fields)
{
    $gates = [];
    foreach ($fields as $field) {
        $name = trim((string)($field['stageInProcess'] ?? ''));
        if ($name === '') {
            continue;
        }
        $optional = array_key_exists('stageRequired', $field) && $field['stageRequired'] === false;
        $gates[$name] = ($gates[$name] ?? false) || !$optional;
    }
    return $gates;
}

function compareFields($oldFields, $newFields, $userName, $version = null)
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
            if (normalizeCalc($oldField) !== normalizeCalc($newField)) {
                $changes[] = [
                    'field' => 'calc',
                    'old' => describeCalc($oldField, $oldFieldsMap),
                    'new' => describeCalc($newField, $newFieldsMap),
                ];
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

    // One entry per stage whose "must be completed first" setting changed —
    // not one per field, though the setting is stored on each field. New and
    // removed stages are covered by their fields' entries.
    $oldGates = stageGates($oldFields);
    foreach (stageGates($newFields) as $stageName => $gate) {
        if (array_key_exists($stageName, $oldGates) && $oldGates[$stageName] !== $gate) {
            $auditEntries[] = [
                'type' => 'stage_modified',
                'stageName' => $stageName,
                'user' => $userName,
                'timestamp' => date('c'),
                'changes' => [
                    ['field' => 'stageRequired', 'old' => $oldGates[$stageName], 'new' => $gate],
                ],
            ];
        }
    }

    if ($version !== null) {
        foreach ($auditEntries as &$e) {
            $e['version'] = $version;
        }
        unset($e);
    }

    return $auditEntries;
}

function generateInitialAuditTrail($fields, $userName, $version = null)
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

    if ($version !== null) {
        foreach ($auditEntries as &$e) {
            $e['version'] = $version;
        }
        unset($e);
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
            'version' => number_format($newVersion, 1),
        ];
        $auditTrail = array_merge($auditTrail, generateInitialAuditTrail($formData['fields'] ?? [], $actorName, number_format($newVersion, 1)));

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
            'department' => $formCategories['department'],
            'program' => $formCategories['program'],
            'formType' => $formCategories['formType'],
        ];

        $oldFormConfig['isLatest'] = false;
    } else {
        $sameNameAndPdfVersions = [versionToDecimal($formConfig['version'] ?? 1.0)];
        foreach ($allForms as $otherForm) {
            if ($otherForm &&
                isset($otherForm['name'], $otherForm['pdfFile']) &&
                $otherForm['name'] === $formData['name'] &&
                $otherForm['pdfFile'] === $formData['pdfFile']) {
                $sameNameAndPdfVersions[] = versionToDecimal($otherForm['version'] ?? 1.0);
            }
        }
        $oldVersion = versionToDecimal($formConfig['version'] ?? 1.0);
        $newVersion = versionToDecimal(max($sameNameAndPdfVersions) + 0.1);

        $storageFilename = $sanitizedName . '_v' . number_format($newVersion, 1) . '_' . time() . '.json';

        $oldFields = $oldFormConfig['fields'] ?? [];
        $newFields = $formData['fields'] ?? [];
        $fieldChanges = compareFields($oldFields, $newFields, $actorName, number_format($newVersion, 1));

        $auditTrail = $formConfig['auditTrail'] ?? [];
        $auditTrail = array_merge($auditTrail, $fieldChanges);
        $auditTrail[] = [
            'type' => 'version_updated',
            'oldVersion' => number_format($oldVersion, 1),
            'newVersion' => number_format($newVersion, 1),
            'user' => $actorName,
            'timestamp' => date('c'),
            'reason' => 'Field modifications',
            'version' => number_format($newVersion, 1),
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
            'department' => $formCategories['department'],
            'program' => $formCategories['program'],
            'formType' => $formCategories['formType'],
        ];

        $oldFormConfig['isLatest'] = false;
    }
} else {
    $sanitizedName = preg_replace('/[^a-zA-Z0-9_-]/', '_', $formData['name']);

    $version = 1.0;
    $sameNameAndPdf = [];
    $sameNameOnly = [];
    foreach ($allForms as $otherForm) {
        if (!$otherForm || !isset($otherForm['name']) || $otherForm['name'] !== $formData['name']) {
            continue;
        }
        $sameNameOnly[] = $otherForm;
        if (isset($otherForm['pdfFile']) && $otherForm['pdfFile'] === $formData['pdfFile']) {
            $sameNameAndPdf[] = $otherForm;
        }
    }

    // Saving without a formId still lands in an existing form's lineage when the
    // name and PDF match: it becomes that form's newest version and pushes the
    // others off "latest". That has to obey the same access rules as an edit,
    // otherwise the gate above is bypassed by dropping the formId.
    $lineageForm = null;
    foreach ($sameNameAndPdf as $candidate) {
        if (ebr_form_is_owned($candidate) && !ebr_form_user_can_edit($candidate, $sessionUser)) {
            http_response_code(403);
            echo json_encode([
                'success' => false,
                'code' => 'not_a_collaborator',
                'message' => 'A form with this name and PDF already exists and you do not have access to it.'
                    . ' Ask one of its owners for access, or save under a different name.',
            ]);
            exit;
        }
        if ($lineageForm === null || (float) ($candidate['version'] ?? 0) > (float) ($lineageForm['version'] ?? 0)) {
            $lineageForm = $candidate;
        }
    }
    if ($lineageForm !== null) {
        // Joining an existing form's lineage: keep its roster and its original
        // creator, so access and ownership do not differ between versions.
        $lineageRoster = ebr_form_roster_for_storage(ebr_form_roster_all($lineageForm));
        if ($lineageRoster !== []) {
            $collaboratorsToStore = $lineageRoster;
        }
        $existingForm = $lineageForm;
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

    $auditTrail = generateInitialAuditTrail($formData['fields'] ?? [], $actorName, number_format($version, 1));

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
        'department' => $formCategories['department'],
        'program' => $formCategories['program'],
        'formType' => $formCategories['formType'],
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
