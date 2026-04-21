<?php
$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

if (preg_match('#^/uploads/[^/]+\.pdf$#i', $uri)) {
    require __DIR__ . '/includes/serve-upload-pdf.php';
    return true;
}

if ($uri !== '/' && file_exists(__DIR__ . $uri) && !is_dir(__DIR__ . $uri)) {
    return false;
}
if (preg_match('#^/(includes|uploads|data|forms)/#', $uri)) {
    return false;
}
$distFile = __DIR__ . '/frontend/dist' . $uri;
if ($uri !== '/' && file_exists($distFile) && !is_dir($distFile)) {
    $mimes = ['js' => 'application/javascript', 'css' => 'text/css', 'html' => 'text/html', 'json' => 'application/json', 'ico' => 'image/x-icon', 'svg' => 'image/svg+xml'];
    $ext = pathinfo($distFile, PATHINFO_EXTENSION);
    if (isset($mimes[$ext])) {
        header('Content-Type: ' . $mimes[$ext]);
    }
    readfile($distFile);
    return true;
}
$index = __DIR__ . '/frontend/dist/index.html';
if (file_exists($index)) {
    header('Content-Type: text/html');
    readfile($index);
    return true;
}
header('Content-Type: text/html');
echo '<!DOCTYPE html><html><head><title>EBR</title></head><body><h1>Electronic Batch Record</h1><p>Run: cd frontend && npm run build</p></body></html>';
return true;
