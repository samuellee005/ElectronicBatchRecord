<?php
/**
 * Load form configuration for a PDF (PostgreSQL ebr_forms)
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-forms.php';

header('Content-Type: application/json');

if (!isset($_GET['pdf'])) {
    echo json_encode(['success' => false, 'message' => 'PDF file not specified']);
    exit;
}

$pdfFile = basename($_GET['pdf']);

try {
    $all = ebr_db_forms_all_api();
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'message' => 'Could not load forms']);
    exit;
}

$latestForm = null;
$latestTime = 0;
$hasLatestFlag = false;

foreach ($all as $formData) {
    if ($formData && isset($formData['pdfFile']) && $formData['pdfFile'] === $pdfFile) {
        $isLatest = isset($formData['isLatest']) && $formData['isLatest'] === true;
        $formTime = strtotime($formData['updatedAt'] ?? $formData['createdAt'] ?? '0');

        if ($isLatest && (!$hasLatestFlag || $formTime > $latestTime)) {
            $hasLatestFlag = true;
            $latestTime = $formTime;
            $latestForm = $formData;
        } elseif (!$hasLatestFlag && $formTime > $latestTime) {
            $latestTime = $formTime;
            $latestForm = $formData;
        }
    }
}

if ($latestForm) {
    if (!isset($latestForm['version'])) {
        $latestForm['version'] = 1.0;
    }
    $latestForm['version'] = round(floatval($latestForm['version']), 1);
    if (!isset($latestForm['isLatest'])) {
        $latestForm['isLatest'] = true;
    }
    echo json_encode(['success' => true, 'form' => $latestForm]);
} else {
    echo json_encode(['success' => false, 'message' => 'No form found for this PDF']);
}
