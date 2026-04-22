<?php

declare(strict_types=1);

/**
 * Stream a PDF template by stored filename (used from router for GET /uploads/*.pdf).
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-pdf-templates.php';

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (!preg_match('#^/uploads/([^/]+\.pdf)$#i', $uri, $m)) {
    http_response_code(400);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Bad request';
    exit;
}

$filename = ebr_db_pdf_template_normalize_filename(rawurldecode($m[1]));
if ($filename === '') {
    http_response_code(400);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Invalid filename';
    exit;
}

$bytes = ebr_db_pdf_template_fetch_bytes_by_filename($filename);
if ($bytes === null || $bytes === '') {
    $legacy = UPLOAD_DIR . $filename;
    if (is_readable($legacy) && strtolower(pathinfo($legacy, PATHINFO_EXTENSION)) === 'pdf') {
        $bytes = (string) file_get_contents($legacy);
    }
}

if ($bytes === null || $bytes === '') {
    http_response_code(404);
    header('Content-Type: text/plain; charset=UTF-8');
    echo 'Template not found';
    exit;
}

header('Content-Type: application/pdf');
header('Content-Disposition: inline; filename="' . str_replace('"', '', $filename) . '"');
header('Cache-Control: private, max-age=3600');
header('Content-Length: ' . (string) strlen($bytes));
echo $bytes;
exit;
