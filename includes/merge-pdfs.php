<?php
/**
 * Merge multiple PDF files into one
 */
require_once __DIR__ . '/../config.php';

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

// If only one PDF, just return it (no merging needed)
if (count($pdfFiles) === 1) {
    $singlePdf = basename($pdfFiles[0]);
    $singlePath = UPLOAD_DIR . $singlePdf;
    
    if (file_exists($singlePath) && strtolower(pathinfo($singlePath, PATHINFO_EXTENSION)) === 'pdf') {
        echo json_encode([
            'success' => true,
            'message' => 'Single PDF file (no merging needed)',
            'filename' => $singlePdf,
            'method' => 'single'
        ]);
        exit;
    } else {
        echo json_encode(['success' => false, 'message' => "PDF file not found: {$singlePdf}"]);
        exit;
    }
}

// Validate all PDF files exist
$validFiles = [];
foreach ($pdfFiles as $pdfFile) {
    $filename = basename($pdfFile);
    $filePath = UPLOAD_DIR . $filename;
    
    if (file_exists($filePath) && strtolower(pathinfo($filePath, PATHINFO_EXTENSION)) === 'pdf') {
        $validFiles[] = $filePath;
    } else {
        echo json_encode(['success' => false, 'message' => "PDF file not found: {$filename}"]);
        exit;
    }
}

if (count($validFiles) < 2) {
    echo json_encode(['success' => false, 'message' => 'Not enough valid PDF files']);
    exit;
}

// Try to merge PDFs using Ghostscript (if available)
$mergedFilename = 'merged_' . time() . '_' . uniqid() . '.pdf';
$mergedPath = UPLOAD_DIR . $mergedFilename;

// Method 1: Try Ghostscript (gs command) - most reliable
// Try common Ghostscript command paths in order of preference
$gsPaths = ['gs', '/usr/bin/gs', '/usr/local/bin/gs'];
$gsCommand = null;

foreach ($gsPaths as $gsPath) {
    // Check if command exists and is executable
    $testCommand = "command -v " . escapeshellarg($gsPath) . " 2>/dev/null";
    exec($testCommand, $testOutput, $testReturn);
    if ($testReturn === 0 && !empty($testOutput)) {
        $gsCommand = trim($testOutput[0]);
        break;
    }
    // Also check if file exists directly
    if (file_exists($gsPath) && is_executable($gsPath)) {
        $gsCommand = $gsPath;
        break;
    }
}

// Fallback: use 'gs' if nothing found (will work if in PATH)
if (!$gsCommand) {
    $gsCommand = 'gs';
}

$gsCommandFull = $gsCommand . ' -dBATCH -dNOPAUSE -q -sDEVICE=pdfwrite -sOutputFile=' . escapeshellarg($mergedPath) . ' ' . implode(' ', array_map('escapeshellarg', $validFiles));
exec($gsCommandFull . ' 2>&1', $output, $returnCode);

if ($returnCode === 0 && file_exists($mergedPath) && filesize($mergedPath) > 0) {
    echo json_encode([
        'success' => true,
        'message' => 'PDFs merged successfully using Ghostscript',
        'filename' => $mergedFilename,
        'method' => 'ghostscript',
        'gsPath' => $gsCommand
    ]);
    exit;
} else {
    // Log the error for debugging
    error_log("Ghostscript merge failed. Command: $gsCommandFull, Return code: $returnCode, Output: " . implode(' ', $output));
}

// Method 2: Try PDFtk (if available)
$pdftkCommand = 'pdftk ' . implode(' ', array_map('escapeshellarg', $validFiles)) . ' cat output ' . escapeshellarg($mergedPath);
exec($pdftkCommand . ' 2>&1', $output, $returnCode);

if ($returnCode === 0 && file_exists($mergedPath) && filesize($mergedPath) > 0) {
    echo json_encode([
        'success' => true,
        'message' => 'PDFs merged successfully',
        'filename' => $mergedFilename,
        'method' => 'pdftk'
    ]);
    exit;
}

// Method 3: Try using FPDI if available via Composer
if (file_exists(__DIR__ . '/../vendor/autoload.php')) {
    require_once __DIR__ . '/../vendor/autoload.php';
    
    try {
        $pdf = new \setasign\Fpdi\Fpdi();
        
        foreach ($validFiles as $file) {
            $pageCount = $pdf->setSourceFile($file);
            
            for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
                $tplId = $pdf->importPage($pageNo);
                $size = $pdf->getTemplateSize($tplId);
                
                if ($size['width'] > $size['height']) {
                    $orientation = 'L';
                } else {
                    $orientation = 'P';
                }
                
                $pdf->AddPage($orientation, [$size['width'], $size['height']]);
                $pdf->useTemplate($tplId);
            }
        }
        
        $pdf->Output('F', $mergedPath);
        
        if (file_exists($mergedPath) && filesize($mergedPath) > 0) {
            echo json_encode([
                'success' => true,
                'message' => 'PDFs merged successfully',
                'filename' => $mergedFilename,
                'method' => 'fpdi'
            ]);
            exit;
        }
    } catch (Exception $e) {
        // Continue to error message
    }
}

// If all methods failed
$errorDetails = '';
if ($output) {
    $errorDetails = ' Details: ' . implode(' ', array_slice($output, 0, 3));
}

echo json_encode([
    'success' => false,
    'message' => 'Failed to merge PDFs. Please ensure Ghostscript (gs), PDFtk, or FPDI library is installed.' . $errorDetails,
    'error' => 'No PDF merging tool available',
    'suggestion' => 'On Linux, install Ghostscript with: sudo apt-get install ghostscript (or: sudo yum install ghostscript)'
]);
