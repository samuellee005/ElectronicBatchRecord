<?php
/**
 * Per-template detected-field suggestions.
 *
 * GET  ?file=<filename>          -> { success, hasSuggestions, fields, count }
 * POST { filename, fields[] }    -> { success, count }
 * DELETE ?file=<filename>        -> { success }
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/require-login.php';
require_once __DIR__ . '/db-pdf-templates.php';

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

try {
    if ($method === 'GET') {
        $file = (string) ($_GET['file'] ?? '');
        if ($file === '') {
            echo json_encode(['success' => false, 'message' => 'Missing file parameter']);
            exit;
        }
        $fields = ebr_db_template_suggestions_get($file);
        echo json_encode([
            'success' => true,
            'hasSuggestions' => $fields !== null,
            'fields' => $fields ?? [],
            'count' => is_array($fields) ? count($fields) : 0,
        ]);
        exit;
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $body = json_decode($raw !== false ? $raw : '[]', true);
        $file = (string) ($body['filename'] ?? '');
        $fields = $body['fields'] ?? null;
        if ($file === '' || !is_array($fields)) {
            echo json_encode(['success' => false, 'message' => 'Missing filename or fields']);
            exit;
        }
        ebr_db_template_suggestions_set($file, $fields);
        echo json_encode(['success' => true, 'count' => count($fields)]);
        exit;
    }

    if ($method === 'DELETE') {
        $file = (string) ($_GET['file'] ?? '');
        if ($file === '') {
            echo json_encode(['success' => false, 'message' => 'Missing file parameter']);
            exit;
        }
        ebr_db_template_suggestions_delete($file);
        echo json_encode(['success' => true]);
        exit;
    }

    http_response_code(405);
    echo json_encode(['success' => false, 'message' => 'Method not allowed']);
} catch (Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'message' => $e->getMessage()]);
}
