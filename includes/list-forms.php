<?php
/**
 * List all saved forms
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

$formsDir = FORMS_DIR;

if (!file_exists($formsDir)) {
    echo json_encode(['success' => true, 'forms' => []]);
    exit;
}

$forms = [];
$formFiles = glob($formsDir . '/*.json');

foreach ($formFiles as $formFile) {
    $formData = json_decode(file_get_contents($formFile), true);
    if ($formData) {
        $forms[] = [
            'id' => $formData['id'] ?? '',
            'name' => $formData['name'] ?? 'Unnamed Form',
            'description' => $formData['description'] ?? '',
            'pdfFile' => $formData['pdfFile'] ?? '',
            'fieldCount' => count($formData['fields'] ?? []),
            'version' => $formData['version'] ?? 1,
            'isLatest' => $formData['isLatest'] ?? true,
            'createdAt' => $formData['createdAt'] ?? '',
            'updatedAt' => $formData['updatedAt'] ?? '',
            'filename' => basename($formFile)
        ];
    }
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

// Sort forms within each group by version (newest first)
foreach ($groupedForms as $key => $group) {
    usort($groupedForms[$key], function($a, $b) {
        $versionA = $a['version'] ?? 1;
        $versionB = $b['version'] ?? 1;
        if ($versionA === $versionB) {
            return strtotime($b['updatedAt']) - strtotime($a['updatedAt']);
        }
        return $versionB - $versionA;
    });
}

// Sort groups by latest update date
usort($groupedForms, function($a, $b) {
    $latestA = $a[0]['updatedAt'] ?? $a[0]['createdAt'] ?? '';
    $latestB = $b[0]['updatedAt'] ?? $b[0]['createdAt'] ?? '';
    return strtotime($latestB) - strtotime($latestA);
});

echo json_encode([
    'success' => true,
    'forms' => $forms, // Keep flat list for backward compatibility
    'groupedForms' => $groupedForms // New grouped structure
]);
