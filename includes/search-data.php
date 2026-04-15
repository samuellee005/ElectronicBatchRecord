<?php
/**
 * Search batch records by title and/or form name; return rows with flattened field values for dynamic table columns.
 */
require_once __DIR__ . '/../config.php';
require_once __DIR__ . '/batch-record.php';

header('Content-Type: application/json');

function searchDataGetEffectiveValue($entry)
{
    if ($entry === null || !is_array($entry)) {
        return is_scalar($entry) ? $entry : '';
    }
    if (!isset($entry['v'])) {
        return '';
    }
    if (!empty($entry['corrections']) && is_array($entry['corrections'])) {
        $last = end($entry['corrections']);
        return $last['to'] ?? $entry['v'];
    }
    return $entry['v'];
}

function searchDataFormatFieldValue($f, $v)
{
    if (($f['type'] ?? '') === 'checkbox') {
        if ($v === null || $v === '') {
            return '';
        }
        $on = $v === true || $v === 'true' || $v === 1 || $v === '1';
        return $on ? '[x]' : '[ ]';
    }
    return searchDataFormatValue($v);
}

function searchDataFormatValue($v)
{
    if ($v === null || $v === '') {
        return '';
    }
    if (is_bool($v)) {
        return $v ? 'Yes' : 'No';
    }
    if (is_array($v)) {
        $allScalar = true;
        foreach ($v as $x) {
            if (!is_scalar($x)) {
                $allScalar = false;
                break;
            }
        }
        return $allScalar ? implode(', ', array_map('strval', $v)) : json_encode($v);
    }
    if (is_string($v) && (strpos($v, 'data:image') === 0 || strlen($v) > 200)) {
        return '[signature / long value]';
    }
    return (string) $v;
}

function searchDataLoadEntryForBatch($batchId, $batch)
{
    $formData = [];
    $entryRaw = null;

    if (!empty($batch['lastEntryFilename'])) {
        $entryPath = DATA_DIR . $batch['lastEntryFilename'];
        if (file_exists($entryPath)) {
            $entryRaw = json_decode(file_get_contents($entryPath), true);
            if ($entryRaw && isset($entryRaw['data'])) {
                $formData = $entryRaw['data'];
            }
        }
    }

    if (!$entryRaw && !empty($batch['lastEntryId'])) {
        $files = glob(DATA_DIR . '*.json');
        foreach ($files as $f) {
            if (strpos($f, 'batch-records') !== false) {
                continue;
            }
            $data = @json_decode(file_get_contents($f), true);
            if (!$data || ($data['id'] ?? '') !== $batch['lastEntryId']) {
                continue;
            }
            $entryRaw = $data;
            $formData = $data['data'] ?? [];
            break;
        }
    }

    if (!$entryRaw) {
        $files = glob(DATA_DIR . '*.json');
        $latest = null;
        foreach ($files as $f) {
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

function searchDataLoadForm($formId)
{
    $formsDir = FORMS_DIR;
    if (!is_dir($formsDir)) {
        return null;
    }
    $found = null;
    foreach (glob($formsDir . '/*.json') as $formFile) {
        $fd = json_decode(file_get_contents($formFile), true);
        if (!$fd || ($fd['id'] ?? '') !== $formId) {
            continue;
        }
        if ($found === null || ($fd['version'] ?? 0) > ($found['version'] ?? 0)) {
            $found = $fd;
        }
    }
    return $found;
}

$q = isset($_GET['q']) ? trim($_GET['q']) : '';
$scope = isset($_GET['scope']) ? trim($_GET['scope']) : 'both';
if (!in_array($scope, ['both', 'batch_title', 'form_name'], true)) {
    $scope = 'both';
}

if ($q === '') {
    echo json_encode([
        'success' => true,
        'message' => 'Enter a search term.',
        'results' => [],
        'columns' => [],
    ]);
    exit;
}

$needle = strtolower($q);
$dir = BATCH_RECORDS_DIR;
$results = [];
$columnSet = [];

if (!is_dir($dir)) {
    echo json_encode(['success' => true, 'results' => [], 'columns' => []]);
    exit;
}

foreach (glob($dir . '/*.json') as $file) {
    $batch = @json_decode(file_get_contents($file), true);
    if (!$batch || empty($batch['id']) || empty($batch['formId'])) {
        continue;
    }
    $batch = ebr_batch_record_ensure_batch_id($batch);

    $title = (string) ($batch['title'] ?? '');
    $formName = (string) ($batch['formName'] ?? '');
    $match = false;

    if ($scope === 'batch_title' || $scope === 'both') {
        if ($needle !== '' && stripos(strtolower($title), $needle) !== false) {
            $match = true;
        }
    }
    if (!$match && ($scope === 'form_name' || $scope === 'both')) {
        if ($needle !== '' && stripos(strtolower($formName), $needle) !== false) {
            $match = true;
        }
    }

    if (!$match) {
        continue;
    }

    $batchId = (string) ($batch['batchId'] ?? $batch['id']);
    [$formData] = searchDataLoadEntryForBatch($batchId, $batch);
    $form = searchDataLoadForm($batch['formId']);

    $fieldValues = [];
    if ($form && !empty($form['fields']) && is_array($form['fields'])) {
        foreach ($form['fields'] as $f) {
            $fid = $f['id'] ?? '';
            $label = trim((string) ($f['label'] ?? $fid));
            if ($label === '') {
                $label = $fid;
            }
            $raw = $formData[$fid] ?? null;
            $val = searchDataFormatFieldValue($f, searchDataGetEffectiveValue($raw));
            if (is_array($raw) && !empty($raw['recordedBy'])) {
                $val .= ' [rec: ' . searchDataFormatValue($raw['recordedBy']) . ']';
            }
            if (isset($fieldValues[$label])) {
                $fieldValues[$label] .= ' | ' . $val;
            } else {
                $fieldValues[$label] = $val;
            }
            $columnSet[$label] = true;
        }
    }

    $results[] = [
        'batchId' => $batchId,
        'title' => $title,
        'formName' => $formName,
        'formId' => $batch['formId'],
        'status' => $batch['status'] ?? 'in_progress',
        'updatedAt' => $batch['updatedAt'] ?? '',
        'fieldValues' => $fieldValues,
    ];
}

$columns = array_keys($columnSet);
sort($columns, SORT_NATURAL | SORT_FLAG_CASE);

echo json_encode([
    'success' => true,
    'results' => $results,
    'columns' => $columns,
    'query' => $q,
    'scope' => $scope,
]);
