<?php
/**
 * List all saved forms (PostgreSQL ebr_forms)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-forms.php';

header('Content-Type: application/json');

try {
    $all = ebr_db_forms_all_api();
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'forms' => [], 'groupedForms' => [], 'message' => 'Could not load forms']);
    exit;
}

$forms = [];
foreach ($all as $formData) {
    $forms[] = [
        'id' => $formData['id'] ?? '',
        'name' => $formData['name'] ?? 'Unnamed Form',
        'description' => $formData['description'] ?? '',
        'pdfFile' => $formData['pdfFile'] ?? '',
        'fieldCount' => count($formData['fields'] ?? []),
        'version' => round(floatval($formData['version'] ?? 1), 1),
        'isLatest' => $formData['isLatest'] ?? true,
        'isCombined' => isset($formData['isCombined']) && $formData['isCombined'] === true,
        'sourceFormIds' => $formData['sourceFormIds'] ?? [],
        'createdAt' => $formData['createdAt'] ?? '',
        'updatedAt' => $formData['updatedAt'] ?? '',
        'filename' => $formData['storageFilename'] ?? ($formData['id'] . '.json'),
        'createdBy' => $formData['createdBy'] ?? null,
        'updatedBy' => $formData['updatedBy'] ?? null,
    ];
}

// Group forms by name and PDF file
$groupedForms = [];
foreach ($forms as $form) {
    $key = $form['name'] . '|' . $form['pdfFile'];
    if (!isset($groupedForms[$key])) {
        $groupedForms[$key] = [];
    }
    $groupedForms[$key][] = $form;
}

// Sort forms within each group by version (highest version first = newest). Compare as decimals.
foreach ($groupedForms as $key => $group) {
    usort($groupedForms[$key], function($a, $b) {
        $versionA = round(floatval($a['version'] ?? 1), 1);
        $versionB = round(floatval($b['version'] ?? 1), 1);
        if (abs($versionA - $versionB) < 0.01) {
            return strtotime($b['updatedAt'] ?? '') - strtotime($a['updatedAt'] ?? '');
        }
        return $versionB <=> $versionA; // higher version first
    });
}

// Sort groups by latest update date
usort($groupedForms, function($a, $b) {
    $latestA = $a[0]['updatedAt'] ?? $a[0]['createdAt'] ?? '';
    $latestB = $b[0]['updatedAt'] ?? $b[0]['createdAt'] ?? '';
    return strtotime($latestB) - strtotime($latestA);
});

// Latest = highest version in each group (first after sort)
$latestIds = [];
foreach ($groupedForms as $group) {
    if (!empty($group)) {
        $latestIds[] = $group[0]['id'];
    }
}
foreach ($forms as &$form) {
    $form['isLatest'] = in_array($form['id'], $latestIds, true);
}
unset($form);

echo json_encode([
    'success' => true,
    'forms' => $forms, // Keep flat list for backward compatibility
    'groupedForms' => $groupedForms // New grouped structure
]);
