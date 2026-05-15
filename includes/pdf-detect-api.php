<?php
/**
 * Proxy PDF field detection to the Python service (OpenCV / PyMuPDF / Tesseract).
 * Configure EBR_PDF_DETECT_URL (e.g. http://pdf-detect:8000) when the service is running.
 *
 * Uses ext-curl when available; otherwise POSTs via stream wrappers (requires allow_url_fopen).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/functions.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
    exit;
}

$base = getenv('EBR_PDF_DETECT_URL');
if ($base === false || trim((string) $base) === '') {
    echo json_encode([
        'success' => false,
        'message' => 'PDF field detection is not configured. Set EBR_PDF_DETECT_URL to the Python service base URL (e.g. http://127.0.0.1:8000) and start the pdf_field_service container or uvicorn.',
        'code' => 'detect_service_unconfigured',
    ]);
    exit;
}

$base = rtrim(trim((string) $base), '/');
$fileKey = isset($_FILES['pdf_file']) ? 'pdf_file' : (isset($_FILES['pdf']) ? 'pdf' : null);
if (!$fileKey || !isset($_FILES[$fileKey])) {
    echo json_encode(['success' => false, 'message' => 'No PDF file uploaded']);
    exit;
}

$err = (int) ($_FILES[$fileKey]['error'] ?? UPLOAD_ERR_NO_FILE);
if ($err !== UPLOAD_ERR_OK) {
    echo json_encode(['success' => false, 'message' => 'Upload error (code ' . $err . ')']);
    exit;
}

$tmp = $_FILES[$fileKey]['tmp_name'];
if (!is_uploaded_file($tmp) && !is_readable($tmp)) {
    echo json_encode(['success' => false, 'message' => 'Could not read uploaded file']);
    exit;
}

if (!ebr_file_looks_like_pdf($tmp)) {
    echo json_encode(['success' => false, 'message' => 'File is not a valid PDF']);
    exit;
}

$url = $base . '/detect';
$timeout = (int) (getenv('EBR_PDF_DETECT_TIMEOUT_SEC') ?: 120);
$includeDebug = isset($_POST['include_debug']) && (string) $_POST['include_debug'] === '1';

/**
 * @return array{http: int, body: string, transport_error: string}
 */
function ebr_pdf_detect_post_pdf(string $url, string $tmpPath, int $timeout, bool $includeDebug): array
{
    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_POST, true);
        $cfile = new CURLFile($tmpPath, 'application/pdf', 'detect.pdf');
        curl_setopt($ch, CURLOPT_POSTFIELDS, [
            'pdf' => $cfile,
            'include_debug' => $includeDebug ? '1' : '0',
        ]);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, min(30, $timeout));
        curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
        $body = curl_exec($ch);
        $curlErr = curl_error($ch);
        $errno = curl_errno($ch);
        $http = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        if ($errno !== 0) {
            return ['http' => 0, 'body' => '', 'transport_error' => $curlErr ?: ('curl errno ' . $errno)];
        }

        return ['http' => $http, 'body' => (string) $body, 'transport_error' => ''];
    }

    if (!filter_var($url, FILTER_VALIDATE_URL)) {
        return ['http' => 0, 'body' => '', 'transport_error' => 'Invalid detection service URL'];
    }

    if (!ini_get('allow_url_fopen')) {
        return [
            'http' => 0,
            'body' => '',
            'transport_error' => 'Install the PHP curl extension (php-curl), or enable allow_url_fopen for HTTP proxy fallback.',
        ];
    }

    $pdf = @file_get_contents($tmpPath);
    if ($pdf === false || $pdf === '') {
        return ['http' => 0, 'body' => '', 'transport_error' => 'Could not read PDF bytes from temp file'];
    }

    $boundary = 'ebr_' . bin2hex(random_bytes(16));
    $prefix = "--{$boundary}\r\n"
        . "Content-Disposition: form-data; name=\"pdf\"; filename=\"detect.pdf\"\r\n"
        . "Content-Type: application/pdf\r\n\r\n";
    $debugPart = "\r\n--{$boundary}\r\n"
        . "Content-Disposition: form-data; name=\"include_debug\"\r\n\r\n"
        . ($includeDebug ? '1' : '0');
    $suffix = "\r\n--{$boundary}--\r\n";
    $payload = $prefix . $pdf . $debugPart . $suffix;

    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: multipart/form-data; boundary={$boundary}\r\n",
            'content' => $payload,
            'timeout' => $timeout,
            'ignore_errors' => true,
        ],
    ]);

    $http = 0;
    $body = @file_get_contents($url, false, $ctx);
    if (isset($http_response_header) && is_array($http_response_header)) {
        foreach ($http_response_header as $h) {
            if (preg_match('#^HTTP/\S+\s+(\d{3})#', $h, $m)) {
                $http = (int) $m[1];
                break;
            }
        }
    }
    if ($body === false) {
        $le = error_get_last();

        return [
            'http' => $http,
            'body' => '',
            'transport_error' => $le['message'] ?? 'file_get_contents failed',
        ];
    }

    return ['http' => $http, 'body' => (string) $body, 'transport_error' => ''];
}

$res = ebr_pdf_detect_post_pdf($url, $tmp, $timeout, $includeDebug);
if ($res['transport_error'] !== '') {
    echo json_encode([
        'success' => false,
        'message' => 'Could not reach PDF detection service: ' . $res['transport_error'],
        'code' => 'detect_service_unreachable',
    ]);
    exit;
}

$http = $res['http'];
$body = $res['body'];

$data = json_decode((string) $body, true);
if (!is_array($data)) {
    echo json_encode([
        'success' => false,
        'message' => 'Detection service returned invalid JSON',
        'httpStatus' => $http,
        'raw' => substr((string) $body, 0, 500),
    ]);
    exit;
}

if ($http >= 400) {
    $msg = $data['detail'] ?? $data['message'] ?? ('HTTP ' . $http);
    echo json_encode(['success' => false, 'message' => is_string($msg) ? $msg : json_encode($msg)]);
    exit;
}

// FastAPI returns { success, suggestions, ... } — normalize for frontend
if (isset($data['success']) && $data['success'] === true) {
    echo json_encode($data);
    exit;
}

echo json_encode([
    'success' => true,
    'pagesAnalyzed' => $data['pagesAnalyzed'] ?? null,
    'pageCount' => $data['pageCount'] ?? null,
    'warnings' => $data['warnings'] ?? [],
    'suggestions' => $data['suggestions'] ?? [],
]);
