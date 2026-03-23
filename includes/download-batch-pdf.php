<?php
/**
 * Export a completed batch record as PDF: template + filled field values + corrections/audit page.
 * Requires FPDI (vendor/autoload.php). Design coordinates are at scale 1.5 vs PDF points.
 */
require_once __DIR__ . '/../config.php';

if (!isset($_GET['batchId'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'batchId required']);
    exit;
}

$batchId = preg_replace('/[^a-zA-Z0-9_-]/', '', $_GET['batchId']);
$batchPath = BATCH_RECORDS_DIR . $batchId . '.json';

if (!file_exists($batchPath)) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Batch not found']);
    exit;
}

$batch = json_decode(file_get_contents($batchPath), true);
if (!$batch || empty($batch['formId'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Invalid batch']);
    exit;
}

// Only allow download for completed batches
if (($batch['status'] ?? '') !== 'completed') {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Only completed records can be downloaded as PDF']);
    exit;
}

// Load entry data
$formData = [];
$entryRaw = null;
if (!empty($batch['lastEntryFilename'])) {
    $entryPath = DATA_DIR . $batch['lastEntryFilename'];
    if (file_exists($entryPath)) {
        $entryRaw = json_decode(file_get_contents($entryPath), true);
        if ($entryRaw && isset($entryRaw['data'])) $formData = $entryRaw['data'];
    }
}
if (!$entryRaw) {
    $files = glob(DATA_DIR . '*.json');
    foreach ($files as $f) {
        if (strpos($f, 'batch-records') !== false) continue;
        $data = @json_decode(file_get_contents($f), true);
        if (!$data || ($data['batchId'] ?? '') !== $batchId) continue;
        $entryRaw = $data;
        $formData = $data['data'] ?? [];
        break;
    }
}

if (!$entryRaw) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'No saved data for this batch']);
    exit;
}

// Load form config
$formId = $batch['formId'];
$formsDir = FORMS_DIR;
$form = null;
if (is_dir($formsDir)) {
    foreach (glob($formsDir . '/*.json') as $formFile) {
        $fd = json_decode(file_get_contents($formFile), true);
        if (!$fd || ($fd['id'] ?? '') !== $formId) continue;
        if ($form === null || ($fd['version'] ?? 0) > ($form['version'] ?? 0)) $form = $fd;
    }
}

if (!$form || empty($form['fields']) || empty($form['pdfFile'])) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Form or template not found']);
    exit;
}

$templatePath = UPLOAD_DIR . basename($form['pdfFile']);
if (!file_exists($templatePath) || strtolower(pathinfo($templatePath, PATHINFO_EXTENSION)) !== 'pdf') {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'Template PDF not found']);
    exit;
}

// Effective value from audit object (last correction or v)
function getEffectiveValue($entry) {
    if ($entry === null || !is_array($entry)) return $entry;
    if (!isset($entry['v'])) return $entry;
    if (!empty($entry['corrections']) && is_array($entry['corrections'])) {
        $last = end($entry['corrections']);
        return $last['to'] ?? $entry['v'];
    }
    return $entry['v'];
}

function formatPdfValue($v) {
    if ($v === null || $v === '') {
        return '';
    }
    if (is_bool($v)) {
        return $v ? 'Yes' : 'No';
    }
    if (is_array($v)) {
        $allScalar = true;
        foreach ($v as $x) {
            if (!is_scalar($x)) {
                $allScalar = false;
                break;
            }
        }
        return $allScalar ? implode(', ', array_map('strval', $v)) : json_encode($v);
    }
    return (string) $v;
}

// Build effective values and corrections list for audit page
$effective = [];
$correctionsList = [];
foreach ($form['fields'] as $field) {
    $id = $field['id'];
    $entry = $formData[$id] ?? null;
    $effective[$id] = getEffectiveValue($entry);
    if (is_array($entry) && !empty($entry['corrections'])) {
        foreach ($entry['corrections'] as $c) {
            $correctionsList[] = [
                'label' => $field['label'] ?? $id,
                'from' => $c['from'] ?? '',
                'to' => $c['to'] ?? '',
                'by' => $c['by'] ?? '',
                'at' => $c['at'] ?? '',
            ];
        }
    }
}

if (!file_exists(__DIR__ . '/../vendor/autoload.php')) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'PDF export requires FPDI (Composer). Install with: composer require setasign/fpdi']);
    exit;
}

require_once __DIR__ . '/../vendor/autoload.php';

$DESIGN_SCALE = 1.5;

try {
    $pdf = new \setasign\Fpdi\Fpdi();
    $pageCount = $pdf->setSourceFile($templatePath);

    for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
        $tplId = $pdf->importPage($pageNo);
        $size = $pdf->getTemplateSize($tplId);
        $w = $size['width'];
        $h = $size['height'];
        $orientation = ($w > $h) ? 'L' : 'P';
        $pdf->AddPage($orientation, [$w, $h]);
        $pdf->useTemplate($tplId);

        foreach ($form['fields'] as $field) {
            if (($field['page'] ?? 1) != $pageNo) continue;
            $id = $field['id'];
            $val = formatPdfValue($effective[$id] ?? '');
            $ent = $formData[$id] ?? null;
            if (is_array($ent) && !empty($ent['recordedBy'])) {
                $val .= ' [Rec: ' . formatPdfValue($ent['recordedBy']) . ']';
            }

            $x = ($field['x'] ?? 0) / $DESIGN_SCALE;
            $y = ($field['y'] ?? 0) / $DESIGN_SCALE;
            $fw = ($field['width'] ?? 100) / $DESIGN_SCALE;
            $fh = ($field['height'] ?? 20) / $DESIGN_SCALE;

            $pdf->SetFont('Helvetica', '', 8);
            $pdf->SetXY($x, $y);
            $pdf->Cell($fw, $fh, $val, 0, 0, 'L');
        }
    }

    // Corrections / Audit page
    if (count($correctionsList) > 0) {
        $pdf->AddPage('P', 'A4');
        $pdf->SetFont('Helvetica', 'B', 14);
        $pdf->Cell(0, 10, 'Corrections & Changes', 0, 1);
        $pdf->SetFont('Helvetica', '', 9);
        $pdf->Ln(4);
        foreach ($correctionsList as $i => $c) {
            $pdf->SetFont('Helvetica', 'B', 9);
            $pdf->Cell(0, 6, ($i + 1) . '. ' . $c['label'], 0, 1);
            $pdf->SetFont('Helvetica', '', 8);
            $pdf->Cell(0, 5, '  From: ' . formatPdfValue($c['from']), 0, 1);
            $pdf->Cell(0, 5, '  To: ' . formatPdfValue($c['to']), 0, 1);
            $pdf->Cell(0, 5, '  By: ' . $c['by'] . ' at ' . $c['at'], 0, 1);
            $pdf->Ln(2);
        }
    }

    if (!empty($batch['completedSignOffBy'])) {
        $pdf->AddPage('P', 'A4');
        $pdf->SetFont('Helvetica', 'B', 12);
        $pdf->Cell(0, 10, 'Batch record sign-off', 0, 1);
        $pdf->SetFont('Helvetica', '', 10);
        $sigAt = $batch['completedSignOffAt'] ?? $batch['completedAt'] ?? '';
        $pdf->Cell(0, 8, 'Secondary reviewer sign-off: ' . formatPdfValue($batch['completedSignOffBy']), 0, 1);
        $pdf->Cell(0, 8, 'Signed off at: ' . formatPdfValue($sigAt), 0, 1);
    }

    $safeTitle = preg_replace('/[^a-zA-Z0-9_-]/', '_', $batch['title'] ?? 'batch');
    $filename = $safeTitle . '_' . date('Y-m-d') . '.pdf';

    header('Content-Type: application/pdf');
    header('Content-Disposition: attachment; filename="' . $filename . '"');
    $pdf->Output('I');
    exit;
} catch (Exception $e) {
    header('Content-Type: application/json');
    echo json_encode(['success' => false, 'message' => 'PDF generation failed: ' . $e->getMessage()]);
}
