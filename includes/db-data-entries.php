<?php

declare(strict_types=1);

/**
 * PostgreSQL persistence for ebr_data_entries (replaces loose JSON files in data/).
 */

require_once __DIR__ . '/db.php';

/**
 * @param mixed $data
 */
function ebr_db_data_json_enc($data): string
{
    $flags = JSON_UNESCAPED_UNICODE;
    if (defined('JSON_INVALID_UTF8_SUBSTITUTE')) {
        $flags |= JSON_INVALID_UTF8_SUBSTITUTE;
    }
    $j = json_encode($data, $flags);
    if ($j === false) {
        throw new RuntimeException('JSON encode failed for data entry');
    }

    return $j;
}

/**
 * UTF-8 JSON as hex for PostgreSQL decode() — avoids PDO/pg quirks with CAST(:x AS jsonb) on bound strings.
 */
function ebr_db_data_json_hex_for_pg(string $utf8Json): string
{
    return bin2hex($utf8Json);
}

/** TIMESTAMPTZ NOT NULL for saved_at */
function ebr_db_data_saved_at_param($v): string
{
    if ($v instanceof \DateTimeInterface) {
        return $v->format('c');
    }
    $s = trim((string) $v);
    if ($s === '') {
        return date('c');
    }

    return $s;
}

/**
 * Normalize JSON/JSONB cell from PDO (string, array, or stream resource).
 *
 * @return array<string, mixed>
 */
function ebr_db_data_jsonb_cell_to_array($v): array
{
    if ($v === null) {
        return [];
    }
    if (is_array($v)) {
        return $v;
    }
    if (is_resource($v)) {
        $v = stream_get_contents($v);
        if ($v === false) {
            return [];
        }
    }
    if (is_string($v)) {
        $d = json_decode($v, true);
        if (is_array($d)) {
            return $d;
        }

        return [];
    }

    return [];
}

/**
 * @param array<string, mixed> $row
 * @return array<string, mixed>
 */
function ebr_db_data_entry_row_to_api(array $row): array
{
    $json = static function ($key) use ($row) {
        return ebr_db_data_jsonb_cell_to_array($row[$key] ?? null);
    };

    $obj = static function ($key) use ($row) {
        return ebr_db_data_jsonb_cell_to_array($row[$key] ?? null);
    };

    return [
        'id' => $row['id'],
        'formId' => $row['form_id'],
        'formName' => $row['form_name'] ?? '',
        'pdfFile' => $row['pdf_file'] ?? '',
        'batchId' => $row['batch_id'],
        'data' => $obj('data'),
        'stageCompletion' => $json('stage_completion'),
        'stages' => $json('stages'),
        'savedAt' => $row['saved_at'] ?? '',
        'filename' => $row['storage_filename'] ?? '',
    ];
}

/**
 * @param array<string, mixed> $dataEntry Same shape as save-data.php $dataEntry
 */
function ebr_db_data_entry_insert(array $dataEntry): void
{
    $pdo = ebr_pg_pdo();
    $sql = <<<'SQL'
INSERT INTO ebr_data_entries (
    id, form_id, form_name, pdf_file, batch_id, data, stage_completion, stages, saved_at, storage_filename
) VALUES (
    :id, :form_id, :form_name, :pdf_file, :batch_id,
    (convert_from(decode(:data_hex, 'hex'), 'UTF8'))::jsonb,
    (convert_from(decode(:sc_hex, 'hex'), 'UTF8'))::jsonb,
    (convert_from(decode(:st_hex, 'hex'), 'UTF8'))::jsonb,
    :saved_at, :storage_filename
)
SQL;
    $st = $pdo->prepare($sql);
    $st->execute([
        'id' => $dataEntry['id'],
        'form_id' => $dataEntry['formId'],
        'form_name' => $dataEntry['formName'] ?? '',
        'pdf_file' => $dataEntry['pdfFile'] ?? '',
        'batch_id' => $dataEntry['batchId'] ?? null,
        'data_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['data'] ?? [])),
        'sc_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['stageCompletion'] ?? [])),
        'st_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['stages'] ?? [])),
        'saved_at' => ebr_db_data_saved_at_param($dataEntry['savedAt'] ?? null),
        'storage_filename' => $dataEntry['filename'] ?? null,
    ]);
}

function ebr_db_data_entry_fetch_by_id(string $entryId): ?array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare('SELECT * FROM ebr_data_entries WHERE id = :id LIMIT 1');
    $st->execute(['id' => $entryId]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    return ebr_db_data_entry_row_to_api($row);
}

/**
 * Latest saved entry for a batch (by saved_at).
 */
function ebr_db_data_entry_latest_for_batch(string $batchId): ?array
{
    $pdo = ebr_pg_pdo();
    $st = $pdo->prepare(
        'SELECT * FROM ebr_data_entries WHERE batch_id = :b ORDER BY saved_at DESC NULLS LAST LIMIT 1'
    );
    $st->execute(['b' => $batchId]);
    $row = $st->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    return ebr_db_data_entry_row_to_api($row);
}

/**
 * Load saved entry for a batch: database first, then legacy JSON files in DATA_DIR.
 *
 * @param array<string, mixed> $batch API-shaped batch row
 * @return array{0: array<string, mixed>, 1: array<string, mixed>|null} [formData, entryRaw]
 */
function ebr_db_entry_resolve_for_batch(array $batch, string $batchId): array
{
    $formData = [];
    $entryRaw = null;

    try {
        if (!empty($batch['lastEntryId'])) {
            $entryRaw = ebr_db_data_entry_fetch_by_id($batch['lastEntryId']);
        }
        if (!$entryRaw) {
            $entryRaw = ebr_db_data_entry_latest_for_batch($batchId);
        }
    } catch (Throwable $e) {
        $entryRaw = null;
    }

    if ($entryRaw && isset($entryRaw['data'])) {
        $formData = $entryRaw['data'];
    }

    if (!$entryRaw && !empty($batch['lastEntryFilename'])) {
        $entryPath = DATA_DIR . $batch['lastEntryFilename'];
        if (file_exists($entryPath)) {
            $entryRaw = json_decode(file_get_contents($entryPath), true);
            if ($entryRaw && isset($entryRaw['data'])) {
                $formData = $entryRaw['data'];
            }
        }
    }

    if (!$entryRaw) {
        $latest = null;
        foreach ((glob(DATA_DIR . '*.json') ?: []) as $f) {
            if (strpos($f, 'batch-records') !== false) {
                continue;
            }
            $data = @json_decode(file_get_contents($f), true);
            if (!$data || ($data['batchId'] ?? '') !== $batchId) {
                continue;
            }
            $savedAt = $data['savedAt'] ?? '';
            if ($latest === null || strcmp($savedAt, $latest['savedAt'] ?? '') > 0) {
                $latest = $data;
            }
        }
        if ($latest) {
            $entryRaw = $latest;
            $formData = $latest['data'] ?? [];
        }
    }

    return [$formData, $entryRaw];
}
