<?php

declare(strict_types=1);

require_once __DIR__ . '/db-batch-records.php';

/**
 * Batch record identity helpers; sequence allocation uses PostgreSQL (ebr_batch_records).
 */

/**
 * Derive 2–4 letter initials from a display name for batch ID nomenclature.
 * Multi-word: first letter of each word (max 4). Single word: first two letters.
 */
function ebr_batch_id_initials(?string $displayName): string
{
    $s = trim((string) $displayName);
    if ($s === '') {
        return 'NA';
    }

    $parts = preg_split('/\s+/u', $s, -1, PREG_SPLIT_NO_EMPTY);
    if ($parts === false || $parts === []) {
        return 'NA';
    }

    $out = '';
    if (count($parts) === 1) {
        $w = $parts[0];
        $len = function_exists('mb_strlen') ? mb_strlen($w, 'UTF-8') : strlen($w);
        $take = min(2, max(1, $len));
        $out = function_exists('mb_substr')
            ? mb_strtoupper(mb_substr($w, 0, $take, 'UTF-8'), 'UTF-8')
            : strtoupper(substr($w, 0, $take));
    } else {
        foreach ($parts as $p) {
            $ch = function_exists('mb_substr')
                ? mb_substr($p, 0, 1, 'UTF-8')
                : substr($p, 0, 1);
            if ($ch !== '') {
                $out .= function_exists('mb_strtoupper')
                    ? mb_strtoupper($ch, 'UTF-8')
                    : strtoupper($ch);
            }
            if (strlen($out) >= 4) {
                break;
            }
        }
    }

    $out = preg_replace('/[^A-Z]/', '', $out) ?? '';
    if ($out === '') {
        return 'NA';
    }

    return substr($out, 0, 4);
}

/**
 * New unique batch identifier (filename stem = this value).
 * Nomenclature: BR-{YEAR}-{INITIALS}-{SEQ} (e.g. BR-2026-SL-00001). SEQ is 5 digits, first batch
 * for that user (initials) in that calendar year is 00001, then 00002, … (per initials+year).
 *
 * @param string|null $createdBy Display name from client; drives initials when present
 */
function ebr_generate_batch_id(?string $createdBy = null): string
{
    if (!defined('BATCH_RECORDS_DIR')) {
        throw new \RuntimeException('BATCH_RECORDS_DIR is not defined');
    }

    $dir = BATCH_RECORDS_DIR;
    $year = date('Y');
    $initials = ebr_batch_id_initials($createdBy);
    $lockPath = $dir . '.generate-batch-id.lock';

    $fp = @fopen($lockPath, 'c+');
    if ($fp === false) {
        throw new \RuntimeException('Could not open batch ID lock file');
    }

    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        throw new \RuntimeException('Could not acquire lock for batch ID generation');
    }

    try {
        $max = ebr_db_batch_max_sequence($year, $initials);
        $next = $max + 1;
        $seq = str_pad((string) $next, 5, '0', STR_PAD_LEFT);
        $id = 'BR-' . $year . '-' . $initials . '-' . $seq;

        return $id;
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

/**
 * Ensure stored/API batch arrays include batchId (alias of id). Legacy JSON may only have id.
 *
 * @param array $record
 * @return array
 */
function ebr_batch_record_ensure_batch_id(array $record): array {
    $id = trim((string) ($record['id'] ?? ''));
    if ($id === '') {
        return $record;
    }
    $existing = trim((string) ($record['batchId'] ?? ''));
    if ($existing === '') {
        $record['batchId'] = $id;
    }

    return $record;
}
