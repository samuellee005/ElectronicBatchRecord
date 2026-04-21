<?php

declare(strict_types=1);

/**
 * Apply database/schema.sql to the configured PostgreSQL database (statements split by ---STATEMENT---).
 * Usage: from project root with env set (e.g. docker compose run --rm ebr php scripts/apply-schema.php)
 *
 * Options:
 *   --reset   Drop existing ebr_* tables (if any), then apply schema (destructive).
 *             Requires the DB user to own those tables (or be superuser). If you get
 *             "must be owner", drop first as the table owner, e.g.:
 *             docker compose run --rm -e EBR_PG_USER=... -e EBR_PG_PASSWORD=... \\
 *               -e EBR_PG_DATABASE=dev ebr php /app/scripts/drop-ebr-tables.php
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

$doReset = in_array('--reset', $argv ?? [], true)
    || in_array('--replace', $argv ?? [], true);

$path = __DIR__ . '/../database/schema.sql';
if (!is_readable($path)) {
    fwrite(STDERR, "Schema file not found: {$path}\n");
    exit(1);
}

$raw = file_get_contents($path);
if ($raw === false) {
    fwrite(STDERR, "Could not read schema file.\n");
    exit(1);
}

$parts = preg_split('/\s*---STATEMENT---\s*/', $raw);
$pdo = ebr_pg_pdo();

if ($doReset) {
    try {
        foreach ([
            'ebr_data_entries',
            'ebr_batch_records',
            'ebr_forms',
            'ebr_user_preferences',
            'ebr_active_users',
            'ebr_pdf_templates',
        ] as $table) {
            $pdo->exec('DROP TABLE IF EXISTS ' . $table . ' CASCADE');
        }
        echo 'Dropped ebr_* tables (if they existed).' . PHP_EOL;
    } catch (PDOException $e) {
        if (str_contains($e->getMessage(), 'must be owner')) {
            fwrite(STDERR, "Cannot DROP: connect as the table owner (or superuser), or run scripts/drop-ebr-tables.php with owner credentials.\n");
        }
        throw $e;
    }
}

$n = 0;
foreach ($parts as $sql) {
    $sql = trim($sql);
    if ($sql === '') {
        continue;
    }
    $pdo->exec($sql);
    $n++;
}

echo "Applied {$n} SQL statement(s) to database " . ebr_resolve_pg_database() . ".\n";
