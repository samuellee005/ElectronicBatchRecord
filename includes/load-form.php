<?php
/**
 * Load form configuration for a PDF
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

if (!isset($_GET['pdf'])) {
    echo json_encode(['success' => false, 'message' => 'PDF file not specified']);
    exit;
}

$pdfFile = basename($_GET['pdf']);
$formsDir = FORMS_DIR;

if (!file_exists($formsDir)) {
    echo json_encode(['success' => false, 'message' => 'No forms directory']);
    exit;
}

// Find the latest form for this PDF (prefer isLatest, then most recent)
$forms = glob($formsDir . '/*.json');
$latestForm = null;
$latestTime = 0;
$hasLatestFlag = false;

foreach ($forms as $formFile) {
    $formData = json_decode(file_get_contents($formFile), true);
    if ($formData && isset($formData['pdfFile']) && $formData['pdfFile'] === $pdfFile) {
        $isLatest = isset($formData['isLatest']) && $formData['isLatest'] === true;
        $formTime = strtotime($formData['updatedAt'] ?? $formData['createdAt'] ?? '0');

        // Prefer forms with isLatest flag
        if ($isLatest && (!$hasLatestFlag || $formTime > $latestTime)) {
            $hasLatestFlag = true;
            $latestTime = $formTime;
            $latestForm = $formData;
        } elseif (!$hasLatestFlag && $formTime > $latestTime) {
            // Fallback to most recent if no isLatest flag found
            $latestTime = $formTime;
            $latestForm = $formData;
        }
    }
}

if ($latestForm) {
    // Ensure version and isLatest properties exist for backward compatibility
    if (!isset($latestForm['version'])) {
        $latestForm['version'] = 1;
    }
    if (!isset($latestForm['isLatest'])) {
        $latestForm['isLatest'] = true;
    }
    echo json_encode(['success' => true, 'form' => $latestForm]);
} else {
    echo json_encode(['success' => false, 'message' => 'No form found for this PDF']);
}
