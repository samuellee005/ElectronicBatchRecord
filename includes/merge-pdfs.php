<?php
/**
 * Merge multiple PDF files into one; inputs and output stored in PostgreSQL (ebr_pdf_templates).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-pdf-templates.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Invalid request method']);
    exit;
}

$input = file_get_contents('php://input');
$data = json_decode($input, true);

if (!$data || !isset($data['pdfFiles']) || !is_array($data['pdfFiles'])) {
    echo json_encode(['success' => false, 'message' => 'Invalid request data']);
    exit;
}

$pdfFiles = $data['pdfFiles'];
if (count($pdfFiles) < 1) {
    echo json_encode(['success' => false, 'message' => 'At least 1 PDF file is required']);
    exit;
}

$tempPaths = [];
$cleanup = static function () use (&$tempPaths) {
    foreach ($tempPaths as $p) {
        ebr_db_pdf_template_unlink_temp($p);
    }
};

if (count($pdfFiles) === 1) {
    $singlePdf = basename((string) $pdfFiles[0]);
    if (!ebr_db_pdf_template_exists($singlePdf)) {
        echo json_encode(['success' => false, 'message' => "PDF file not found: {$singlePdf}"]);
        exit;
    }
    echo json_encode([
        'success' => true,
        'message' => 'Single PDF file (no merging needed)',
        'filename' => $singlePdf,
        'method' => 'single',
    ]);
    exit;
}

$validFiles = [];
foreach ($pdfFiles as $pdfFile) {
    $filename = basename((string) $pdfFile);
    $tmp = ebr_db_pdf_template_materialize_to_temp($filename);
    if ($tmp === null || !is_readable($tmp)) {
        $cleanup();
        echo json_encode(['success' => false, 'message' => "PDF file not found: {$filename}"]);
        exit;
    }
    $tempPaths[] = $tmp;
    $validFiles[] = $tmp;
}

if (count($validFiles) < 2) {
    $cleanup();
    echo json_encode(['success' => false, 'message' => 'Not enough valid PDF files']);
    exit;
}

$mergedFilename = 'merged_' . time() . '_' . uniqid() . '.pdf';
$mergedTmp = tempnam(sys_get_temp_dir(), 'ebrmergeout');
if ($mergedTmp === false) {
    $cleanup();
    echo json_encode(['success' => false, 'message' => 'Could not create temp file for merge output']);
    exit;
}
$mergedPath = $mergedTmp . '.pdf';
if (!@rename($mergedTmp, $mergedPath)) {
    $mergedPath = $mergedTmp;
}
$tempPaths[] = $mergedPath;

$gsPaths = ['gs', '/usr/bin/gs', '/usr/local/bin/gs'];
$gsCommand = null;
foreach ($gsPaths as $gsPath) {
    $testCommand = 'command -v ' . escapeshellarg($gsPath) . ' 2>/dev/null';
    exec($testCommand, $testOutput, $testReturn);
    if ($testReturn === 0 && !empty($testOutput)) {
        $gsCommand = trim($testOutput[0]);
        break;
    }
    if (file_exists($gsPath) && is_executable($gsPath)) {
        $gsCommand = $gsPath;
        break;
    }
}
if (!$gsCommand) {
    $gsCommand = 'gs';
}

$gsCommandFull = $gsCommand . ' -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile=' . escapeshellarg($mergedPath) . ' ' . implode(' ', array_map('escapeshellarg', $validFiles));
exec($gsCommandFull . ' 2>&1', $output, $returnCode);

if ($returnCode === 0 && file_exists($mergedPath) && filesize($mergedPath) > 0) {
    $bin = (string) file_get_contents($mergedPath);
    $cleanup();
    try {
        ebr_db_pdf_template_insert('tpl_' . bin2hex(random_bytes(8)), $mergedFilename, $mergedFilename, $bin);
    } catch (Throwable $e) {
        echo json_encode(['success' => false, 'message' => 'Merge succeeded but failed to store merged PDF in database.']);
        exit;
    }
    echo json_encode([
        'success' => true,
        'message' => 'PDFs merged successfully using Ghostscript',
        'filename' => $mergedFilename,
        'method' => 'ghostscript',
        'gsPath' => $gsCommand,
    ]);
    exit;
}

error_log('Ghostscript merge failed. Command: ' . $gsCommandFull . ', Return code: ' . $returnCode);

$pdftkCommand = 'pdftk ' . implode(' ', array_map('escapeshellarg', $validFiles)) . ' cat output ' . escapeshellarg($mergedPath);
exec($pdftkCommand . ' 2>&1', $output2, $returnCode2);

if ($returnCode2 === 0 && file_exists($mergedPath) && filesize($mergedPath) > 0) {
    $bin = (string) file_get_contents($mergedPath);
    $cleanup();
    try {
        ebr_db_pdf_template_insert('tpl_' . bin2hex(random_bytes(8)), $mergedFilename, $mergedFilename, $bin);
    } catch (Throwable $e) {
        echo json_encode(['success' => false, 'message' => 'Merge succeeded but failed to store merged PDF in database.']);
        exit;
    }
    echo json_encode([
        'success' => true,
        'message' => 'PDFs merged successfully',
        'filename' => $mergedFilename,
        'method' => 'pdftk',
    ]);
    exit;
}

if (file_exists(__DIR__ . '/../vendor/autoload.php')) {
    require_once __DIR__ . '/../vendor/autoload.php';
    try {
        $pdf = new \setasign\Fpdi\Fpdi();
        foreach ($validFiles as $file) {
            $pageCount = $pdf->setSourceFile($file);
            for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
                $tplId = $pdf->importPage($pageNo);
                $size = $pdf->getTemplateSize($tplId);
                $orientation = ($size['width'] > $size['height']) ? 'L' : 'P';
                $pdf->AddPage($orientation, [$size['width'], $size['height']]);
                $pdf->useTemplate($tplId);
            }
        }
        $pdf->Output('F', $mergedPath);
        if (file_exists($mergedPath) && filesize($mergedPath) > 0) {
            $bin = (string) file_get_contents($mergedPath);
            $cleanup();
            try {
                ebr_db_pdf_template_insert('tpl_' . bin2hex(random_bytes(8)), $mergedFilename, $mergedFilename, $bin);
            } catch (Throwable $e) {
                echo json_encode(['success' => false, 'message' => 'Merge succeeded but failed to store merged PDF in database.']);
                exit;
            }
            echo json_encode([
                'success' => true,
                'message' => 'PDFs merged successfully',
                'filename' => $mergedFilename,
                'method' => 'fpdi',
            ]);
            exit;
        }
    } catch (Exception $e) {
        // fall through
    }
}

$cleanup();
$errorDetails = '';
if (!empty($output)) {
    $errorDetails = ' Details: ' . implode(' ', array_slice($output, 0, 3));
}

echo json_encode([
    'success' => false,
    'message' => 'Failed to merge PDFs. Please ensure Ghostscript (gs), PDFtk, or FPDI library is installed.' . $errorDetails,
    'error' => 'No PDF merging tool available',
    'suggestion' => 'On Linux, install Ghostscript with: sudo apt-get install ghostscript (or: sudo yum install ghostscript)',
]);
