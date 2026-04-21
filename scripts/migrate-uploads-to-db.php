<?php

declare(strict_types=1);

/**
 * Import existing files from UPLOAD_DIR into ebr_pdf_templates (skips filenames already in DB).
 * Usage: php scripts/migrate-uploads-to-db.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db-pdf-templates.php';

$dir = UPLOAD_DIR;
if (!is_dir($dir)) {
    fwrite(STDOUT, "No uploads directory.\n");
    exit(0);
}

$n = 0;
foreach (glob($dir . '*.pdf') ?: [] as $path) {
    $name = basename($path);
    if ($name === '' || strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'pdf') {
        continue;
    }
    try {
        if (ebr_db_pdf_template_exists($name)) {
            fwrite(STDOUT, "Skip (exists in DB): {$name}\n");
            continue;
        }
    } catch (Throwable $e) {
        fwrite(STDERR, 'Database error: ' . $e->getMessage() . "\n");
        exit(1);
    }
    $bin = @file_get_contents($path);
    if ($bin === false || $bin === '') {
        fwrite(STDERR, "Skip (unreadable): {$name}\n");
        continue;
    }
    try {
        ebr_db_pdf_template_insert('tpl_' . bin2hex(random_bytes(8)), $name, $name, $bin);
        fwrite(STDOUT, "Imported: {$name}\n");
        $n++;
    } catch (Throwable $e) {
        fwrite(STDERR, "Failed {$name}: " . $e->getMessage() . "\n");
        exit(1);
    }
}

fwrite(STDOUT, "Done. Imported {$n} file(s).\n");
