<?php
/**
 * List uploaded PDF templates (PostgreSQL ebr_pdf_templates).
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/db-pdf-templates.php';

header('Content-Type: application/json');

try {
    $pdfs = ebr_db_pdf_template_list_for_api();
} catch (Throwable $e) {
    echo json_encode(['success' => false, 'pdfs' => [], 'message' => 'Could not list templates']);
    exit;
}

echo json_encode([
    'success' => true,
    'pdfs' => $pdfs,
]);
