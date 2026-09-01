<?php

declare(strict_types=1);

/**
 * PostgreSQL persistence for ebr_data_entries (replaces loose JSON files in data/).
 */

require_once __DIR__ . '/db.php';
require_once __DIR__ . '/../config.php';

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
        'savedByUserId' => isset($row['saved_by_user_id']) && $row['saved_by_user_id'] !== null
            ? (int) $row['saved_by_user_id'] : null,
        'savedByUsername' => (string) ($row['saved_by_username'] ?? ''),
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
    id, form_id, form_name, pdf_file, batch_id, data, stage_completion, stages, saved_at,
    storage_filename, saved_by_user_id, saved_by_username
) VALUES (
    :id, :form_id, :form_name, :pdf_file, :batch_id,
    (convert_from(decode(:data_hex, 'hex'), 'UTF8'))::jsonb,
    (convert_from(decode(:sc_hex, 'hex'), 'UTF8'))::jsonb,
    (convert_from(decode(:st_hex, 'hex'), 'UTF8'))::jsonb,
    :saved_at, :storage_filename, :saved_by_user_id, :saved_by_username
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
        'saved_by_user_id' => ((int) ($dataEntry['savedByUserId'] ?? 0)) > 0
            ? (int) $dataEntry['savedByUserId'] : null,
        'saved_by_username' => trim((string) ($dataEntry['savedByUsername'] ?? '')) ?: null,
    ]);
}

/**
 * Update the most-recent entry for a batch in place — the target of autosave,
 * which keeps one evolving working row instead of appending on every keystroke.
 * Returns false when the batch has no entry yet (caller should insert instead).
 */
function ebr_db_data_entry_update_latest_for_batch(string $batchId, array $dataEntry): bool
{
    $pdo = ebr_pg_pdo();
    $idStmt = $pdo->prepare(
        'SELECT id FROM ebr_data_entries WHERE batch_id = :b ORDER BY saved_at DESC NULLS LAST LIMIT 1'
    );
    $idStmt->execute(['b' => $batchId]);
    $rowId = $idStmt->fetchColumn();
    if ($rowId === false) {
        return false;
    }

    $sql = <<<'SQL'
UPDATE ebr_data_entries SET
    data = (convert_from(decode(:data_hex, 'hex'), 'UTF8'))::jsonb,
    stage_completion = (convert_from(decode(:sc_hex, 'hex'), 'UTF8'))::jsonb,
    stages = (convert_from(decode(:st_hex, 'hex'), 'UTF8'))::jsonb,
    saved_at = :saved_at,
    saved_by_user_id = :saved_by_user_id,
    saved_by_username = :saved_by_username
WHERE id = :id
SQL;
    $st = $pdo->prepare($sql);
    $st->execute([
        'id' => $rowId,
        'data_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['data'] ?? [])),
        'sc_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['stageCompletion'] ?? [])),
        'st_hex' => ebr_db_data_json_hex_for_pg(ebr_db_data_json_enc($dataEntry['stages'] ?? [])),
        'saved_at' => ebr_db_data_saved_at_param($dataEntry['savedAt'] ?? null),
        'saved_by_user_id' => ((int) ($dataEntry['savedByUserId'] ?? 0)) > 0
            ? (int) $dataEntry['savedByUserId'] : null,
        'saved_by_username' => trim((string) ($dataEntry['savedByUsername'] ?? '')) ?: null,
    ]);

    return true;
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

    if (ebr_legacy_json_fallback_enabled()) {
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
    }

    return [$formData, $entryRaw];
}
