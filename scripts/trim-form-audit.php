<?php

declare(strict_types=1);

/**
 * Trim each form version's audit trail down to the changes that save made.
 *
 * Saves used to copy the previous version's whole trail onto the new version,
 * so version N held every entry from 1.0 to N. A version now records only what
 * its save added, edited or deleted (earlier changes stay on earlier versions);
 * this script brings the versions saved before that change into line.
 *
 * Each old version's trail is the previous version's trail plus that save's
 * entries, so walking a form's versions oldest first and dropping the entries
 * an earlier version already recorded leaves exactly that save's entries.
 * Entries are matched by their full content and counted, so a genuine repeat
 * is never dropped. Versions already in the new shape are left as they are, so
 * running the script again changes nothing.
 *
 * Usage (from the project root, or inside the container):
 *   php scripts/trim-form-audit.php            dry run: report what would change
 *   php scripts/trim-form-audit.php --apply    make the change
 *
 * With --apply, every trail that is changed is first copied to the table
 * ebr_forms_audit_trail_backup (id, audit_trail, backed_up_at). Once the audit
 * pages have been checked, the backup can be dropped to reclaim the space:
 *   DROP TABLE ebr_forms_audit_trail_backup;
 * --no-backup skips the copy.
 */

require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/../includes/db.php';

$args = $argv ?? [];
$apply = in_array('--apply', $args, true);
$backup = !in_array('--no-backup', $args, true);

$pdo = ebr_pg_pdo();

/** Identity of an entry for matching copies across versions (jsonb decodes with a stable key order). */
function trim_audit_key($entry): string
{
    return md5(json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) ?: '');
}

$lineages = $pdo->query(
    'SELECT DISTINCT COALESCE(lineage_id, id) AS lineage FROM ebr_forms ORDER BY 1'
)->fetchAll(PDO::FETCH_COLUMN);

$sizeBefore = (int) $pdo->query('SELECT COALESCE(SUM(pg_column_size(audit_trail)), 0) FROM ebr_forms')->fetchColumn();

if ($apply && $backup) {
    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS ebr_forms_audit_trail_backup (
            id TEXT PRIMARY KEY,
            audit_trail JSONB NOT NULL,
            backed_up_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )'
    );
}

$versionsSeen = 0;
$versionsChanged = 0;
$entriesBefore = 0;
$entriesAfter = 0;
// Kept entries whose own `version` names a different version than the row
// they stay on — a sign the walk order and the history disagree. Expected 0.
$versionMismatches = 0;
$mismatchSamples = [];

$listVersions = $pdo->prepare(
    'SELECT id, version, name FROM ebr_forms
     WHERE lineage_id = :l OR (lineage_id IS NULL AND id = :l)
     ORDER BY version ASC, updated_at ASC, id ASC'
);
$readTrail = $pdo->prepare('SELECT audit_trail FROM ebr_forms WHERE id = :id');
$writeTrail = $pdo->prepare('UPDATE ebr_forms SET audit_trail = CAST(:t AS jsonb) WHERE id = :id');
$saveBackup = $pdo->prepare(
    'INSERT INTO ebr_forms_audit_trail_backup (id, audit_trail)
     SELECT id, audit_trail FROM ebr_forms WHERE id = :id
     ON CONFLICT (id) DO NOTHING'
);

foreach ($lineages as $lineage) {
    $listVersions->execute(['l' => $lineage]);
    $versions = $listVersions->fetchAll(PDO::FETCH_ASSOC);

    if ($apply) {
        $pdo->beginTransaction();
    }
    try {
        // Every entry recorded by an earlier version of this form, with counts.
        $seen = [];
        foreach ($versions as $row) {
            $versionsSeen++;
            $readTrail->execute(['id' => $row['id']]);
            $raw = $readTrail->fetchColumn();
            $trail = is_string($raw) ? json_decode($raw, true) : null;
            if (!is_array($trail)) {
                continue;
            }
            $entriesBefore += count($trail);

            $available = $seen;
            $own = [];
            foreach ($trail as $entry) {
                $k = trim_audit_key($entry);
                if (($available[$k] ?? 0) > 0) {
                    $available[$k]--;
                    continue;
                }
                $own[] = $entry;
            }
            foreach ($own as $entry) {
                $k = trim_audit_key($entry);
                $seen[$k] = ($seen[$k] ?? 0) + 1;
                $v = is_array($entry) ? ($entry['version'] ?? null) : null;
                if ($v !== null && abs((float) $v - (float) $row['version']) > 0.001) {
                    $versionMismatches++;
                    if (count($mismatchSamples) < 10) {
                        $mismatchSamples[] = sprintf(
                            '%s (%s v%s): kept entry "%s" from v%s',
                            $row['id'],
                            $row['name'],
                            number_format((float) $row['version'], 1),
                            (string) ($entry['type'] ?? '?'),
                            (string) $v
                        );
                    }
                }
            }
            $entriesAfter += count($own);

            if (count($own) !== count($trail)) {
                $versionsChanged++;
                if ($apply) {
                    if ($backup) {
                        $saveBackup->execute(['id' => $row['id']]);
                    }
                    $writeTrail->execute([
                        'id' => $row['id'],
                        't' => json_encode($own, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE),
                    ]);
                }
            }
            unset($trail, $raw, $own, $available);
        }
        if ($apply) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($apply && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        fwrite(STDERR, "Form {$lineage}: {$e->getMessage()} — left unchanged.\n");
    }
}

printf("%s\n", $apply ? 'Applied.' : 'Dry run — nothing changed. Re-run with --apply to make the change.');
printf("Forms: %d, versions: %d, versions to trim: %d\n", count($lineages), $versionsSeen, $versionsChanged);
printf("Audit entries stored: %d before, %d after\n", $entriesBefore, $entriesAfter);
printf("Kept entries naming a different version: %d (expected 0)\n", $versionMismatches);
foreach ($mismatchSamples as $line) {
    printf("  %s\n", $line);
}
if ($apply) {
    $sizeAfter = (int) $pdo->query('SELECT COALESCE(SUM(pg_column_size(audit_trail)), 0) FROM ebr_forms')->fetchColumn();
    printf("audit_trail size: %.1f MB before, %.1f MB after\n", $sizeBefore / 1048576, $sizeAfter / 1048576);
    if ($backup && $versionsChanged > 0) {
        echo "Original trails copied to ebr_forms_audit_trail_backup. Drop it once the audit pages look right.\n";
    }
} else {
    printf("audit_trail size now: %.1f MB\n", $sizeBefore / 1048576);
}
