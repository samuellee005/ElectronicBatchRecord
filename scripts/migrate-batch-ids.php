<?php
/**
 * One-time migration: rename legacy batch record IDs to BR-{YEAR}-{INITIALS}-{#####}
 * and update batchId references in data entry JSON files under data/.
 *
 * Usage (from project root):
 *   php scripts/migrate-batch-ids.php --dry-run
 *   php scripts/migrate-batch-ids.php
 */
declare(strict_types=1);

$dryRun = in_array('--dry-run', $argv ?? [], true) || in_array('-n', $argv ?? [], true);

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/batch-record.php';

function ebr_migrate_is_canonical_batch_id(string $id): bool
{
    return (bool) preg_match('/^BR-\d{4}-[A-Z]{2,4}-\d{5}$/', $id);
}

function ebr_migrate_batch_year(array $record, string $path): string
{
    $ts = strtotime((string) ($record['createdAt'] ?? ''));
    if ($ts === false) {
        $ts = @filemtime($path) ?: time();
    }

    return date('Y', $ts);
}

/**
 * @return list<array{path: string, id: string, record: array, year: string, initials: string, createdTs: int, canonical: bool}>
 */
function ebr_migrate_load_batch_items(string $dir): array
{
    $items = [];
    foreach (glob($dir . '*.json') ?: [] as $path) {
        $base = basename($path, '.json');
        if ($base === '' || str_starts_with($base, '.')) {
            continue;
        }
        $raw = @file_get_contents($path);
        if ($raw === false) {
            fwrite(STDERR, "Skip unreadable: {$path}\n");
            continue;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            fwrite(STDERR, "Skip invalid JSON: {$path}\n");
            continue;
        }
        $id = trim((string) ($data['id'] ?? $base));
        if ($id === '') {
            continue;
        }
        $year = ebr_migrate_batch_year($data, $path);
        $initials = ebr_batch_id_initials($data['createdBy'] ?? null);
        $createdTs = strtotime((string) ($data['createdAt'] ?? ''));
        if ($createdTs === false) {
            $createdTs = (int) @filemtime($path);
        }
        $items[] = [
            'path' => $path,
            'id' => $id,
            'record' => $data,
            'year' => $year,
            'initials' => $initials,
            'createdTs' => $createdTs,
            'canonical' => ebr_migrate_is_canonical_batch_id($id),
        ];
    }

    return $items;
}

/**
 * @param list<array{path: string, id: string, record: array, year: string, initials: string, createdTs: int, canonical: bool}> $items
 * @return array<string, string> oldId => newId
 */
function ebr_migrate_build_map(array $items): array
{
    $groups = [];
    foreach ($items as $item) {
        $key = $item['year'] . '|' . $item['initials'];
        if (!isset($groups[$key])) {
            $groups[$key] = [];
        }
        $groups[$key][] = $item;
    }

    $mappings = [];

    foreach ($groups as $key => $groupItems) {
        $maxSeq = 0;
        $nonCanonical = [];
        foreach ($groupItems as $it) {
            if ($it['canonical'] && preg_match('/^BR-\d{4}-[A-Z]{2,4}-(\d{5})$/', $it['id'], $m)) {
                $maxSeq = max($maxSeq, (int) $m[1]);
            } elseif (!$it['canonical']) {
                $nonCanonical[] = $it;
            }
        }

        usort(
            $nonCanonical,
            static function (array $a, array $b): int {
                $c = $a['createdTs'] <=> $b['createdTs'];
                return $c !== 0 ? $c : strcmp($a['id'], $b['id']);
            }
        );

        foreach ($nonCanonical as $it) {
            ++$maxSeq;
            [$year, $initials] = explode('|', $key, 2);
            $newId = sprintf('BR-%s-%s-%05d', $year, $initials, $maxSeq);
            $mappings[$it['id']] = $newId;
        }
    }

    $newIds = array_values($mappings);
    if (count($newIds) !== count(array_unique($newIds))) {
        throw new RuntimeException('Internal error: duplicate target IDs in migration map.');
    }

    return $mappings;
}

/**
 * @param array<string, string> $mappings
 */
function ebr_migrate_update_entry_files(string $dataDir, array $mappings, bool $dryRun): int
{
    $updated = 0;
    foreach (glob($dataDir . '*.json') ?: [] as $path) {
        $raw = @file_get_contents($path);
        if ($raw === false) {
            continue;
        }
        $data = json_decode($raw, true);
        if (!is_array($data)) {
            continue;
        }
        $bid = isset($data['batchId']) ? trim((string) $data['batchId']) : '';
        if ($bid === '' || !isset($mappings[$bid])) {
            continue;
        }
        $newBid = $mappings[$bid];
        if ($dryRun) {
            fwrite(STDOUT, "  entry: {$path}\n    batchId: {$bid} -> {$newBid}\n");
            ++$updated;
            continue;
        }
        $data['batchId'] = $newBid;
        file_put_contents($path, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        ++$updated;
    }

    return $updated;
}

/**
 * @param array<string, string> $mappings
 */
function ebr_migrate_apply_batch_files(string $dir, array $mappings, bool $dryRun): int
{
    $n = 0;
    foreach ($mappings as $oldId => $newId) {
        $oldPath = $dir . $oldId . '.json';
        $newPath = $dir . $newId . '.json';
        if (!is_file($oldPath)) {
            fwrite(STDERR, "  Missing batch file (skipped): {$oldPath}\n");
            continue;
        }
        if (is_file($newPath)) {
            fwrite(STDERR, "  Target already exists (abort): {$newPath}\n");
            exit(1);
        }
        if ($dryRun) {
            fwrite(STDOUT, "  batch: {$oldId} -> {$newId}\n");
            ++$n;
            continue;
        }
        $data = json_decode((string) file_get_contents($oldPath), true);
        if (!is_array($data)) {
            fwrite(STDERR, "  Invalid batch JSON: {$oldPath}\n");
            exit(1);
        }
        $data['id'] = $newId;
        $data['batchId'] = $newId;
        file_put_contents($newPath, json_encode($data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        if (!unlink($oldPath)) {
            fwrite(STDERR, "  Failed to remove old file: {$oldPath}\n");
            exit(1);
        }
        ++$n;
    }

    return $n;
}

// ─── Main ─────────────────────────────────────────────────────────────

$items = ebr_migrate_load_batch_items(BATCH_RECORDS_DIR);
$mappings = ebr_migrate_build_map($items);

if ($mappings === []) {
    fwrite(STDOUT, "Nothing to migrate (all batch IDs already canonical, or no batch records).\n");
    exit(0);
}

fwrite(STDOUT, ($dryRun ? 'DRY RUN — ' : '') . 'Migrating ' . count($mappings) . " batch record(s).\n");

fwrite(STDOUT, "\nBatch record files:\n");
$nBatch = ebr_migrate_apply_batch_files(BATCH_RECORDS_DIR, $mappings, $dryRun);
fwrite(STDOUT, '  ' . ($dryRun ? 'Would rename' : 'Renamed') . " {$nBatch} batch record file(s).\n");

fwrite(STDOUT, "\nData entry files (data/*.json):\n");
$entryUpdates = ebr_migrate_update_entry_files(DATA_DIR, $mappings, $dryRun);
fwrite(STDOUT, '  ' . ($dryRun ? 'Would update' : 'Updated') . " {$entryUpdates} entry file(s).\n");

if ($dryRun) {
    fwrite(STDOUT, "\nRun without --dry-run to apply.\n");
}

exit(0);
