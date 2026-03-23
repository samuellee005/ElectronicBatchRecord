<?php
/**
 * Test if Ghostscript is available
 */
require_once __DIR__ . '/../config.php';

header('Content-Type: application/json');

// Try to find Ghostscript
$gsPaths = ['gs', '/usr/bin/gs', '/usr/local/bin/gs'];
$gsFound = false;
$gsPath = null;
$gsVersion = null;

foreach ($gsPaths as $path) {
    $testCommand = "command -v $path 2>/dev/null || which $path 2>/dev/null";
    exec($testCommand, $testOutput, $testReturn);
    if ($testReturn === 0 || file_exists($path)) {
        // Test if it actually works
        exec("$path --version 2>&1", $versionOutput, $versionReturn);
        if ($versionReturn === 0) {
            $gsFound = true;
            $gsPath = $path;
            $gsVersion = implode(' ', $versionOutput);
            break;
        }
    }
}

// Also check common installation locations
if (!$gsFound) {
    $commonPaths = ['/usr/bin/gs', '/usr/local/bin/gs', '/bin/gs'];
    foreach ($commonPaths as $commonPath) {
        if (file_exists($commonPath)) {
            exec("$commonPath --version 2>&1", $versionOutput, $versionReturn);
            if ($versionReturn === 0) {
                $gsFound = true;
                $gsPath = $commonPath;
                $gsVersion = implode(' ', $versionOutput);
                break;
            }
        }
    }
}

echo json_encode([
    'success' => $gsFound,
    'found' => $gsFound,
    'path' => $gsPath,
    'version' => $gsVersion,
    'message' => $gsFound 
        ? "Ghostscript found at: $gsPath" 
        : 'Ghostscript not found. Please install it with: sudo apt-get install ghostscript',
    'installCommand' => 'sudo apt-get install ghostscript'
]);
