<?php
/**
 * Shared batch PDF generation (FPDI). Used by download-batch-pdf.php and export-batch-pdf.php.
 */
if (defined('EBR_PDF_BATCH_EXPORT_LOADED')) {
    return;
}
define('EBR_PDF_BATCH_EXPORT_LOADED', true);

require_once __DIR__ . '/db-pdf-templates.php';

function ebr_get_effective_value($entry) {
    if ($entry === null || !is_array($entry)) {
        return $entry;
    }
    if (!isset($entry['v'])) {
        return $entry;
    }
    if (!empty($entry['corrections']) && is_array($entry['corrections'])) {
        $last = end($entry['corrections']);
        return $last['to'] ?? $entry['v'];
    }
    return $entry['v'];
}

function ebr_format_pdf_field_value($field, $v) {
    if (($field['type'] ?? '') === 'checkbox') {
        if ($v === null || $v === '') {
            return '';
        }
        $on = $v === true || $v === 'true' || $v === 1 || $v === '1';
        return $on ? '[x]' : '[ ]';
    }
    if (ebr_is_table_field($field)) {
        return ebr_format_pdf_table_value($field, $v);
    }
    return ebr_format_pdf_value($v);
}

function ebr_format_pdf_value($v) {
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
    return (string) $v;
}

const EBR_TABLE_KEY_SEP = '::';

function ebr_table_cell_key($rowId, $colId) {
    return $rowId . EBR_TABLE_KEY_SEP . $colId;
}

/** @return array<string, mixed> */
function ebr_normalize_table_cells($v) {
    if (is_array($v) && isset($v['cells']) && is_array($v['cells'])) {
        return $v['cells'];
    }
    return [];
}

/**
 * Mirrors frontend buildTableMergeLayout (tableMergeLayout.js).
 *
 * @return array{rowIds: list<string>, colIds: list<string>, covered: array<string, true>, spanOf: array}
 */
function ebr_build_table_merge_layout(array $field) {
    $rowIds = [];
    foreach ($field['tableRows'] ?? [] as $r) {
        if (isset($r['id'])) {
            $rowIds[] = $r['id'];
        }
    }
    $colIds = [];
    foreach ($field['tableColumns'] ?? [] as $c) {
        if (isset($c['id'])) {
            $colIds[] = $c['id'];
        }
    }
    $covered = [];
    $spanOf = [];
    foreach ($field['tableMerges'] ?? [] as $m) {
        $anchorRowId = $m['anchorRowId'] ?? '';
        $anchorColId = $m['anchorColId'] ?? '';
        $ri = array_search($anchorRowId, $rowIds, true);
        $ci = array_search($anchorColId, $colIds, true);
        if ($ri === false || $ci === false) {
            continue;
        }
        $rs = max(1, (int) ($m['rowspan'] ?? 1));
        $cs = max(1, (int) ($m['colspan'] ?? 1));
        if ($ri + $rs > count($rowIds) || $ci + $cs > count($colIds)) {
            continue;
        }
        $anchorKey = ebr_table_cell_key($rowIds[$ri], $colIds[$ci]);
        $spanOf[$anchorKey] = ['rowspan' => $rs, 'colspan' => $cs];
        for ($dr = 0; $dr < $rs; $dr++) {
            for ($dc = 0; $dc < $cs; $dc++) {
                if ($dr === 0 && $dc === 0) {
                    continue;
                }
                $rk = $rowIds[$ri + $dr] ?? null;
                $ck = $colIds[$ci + $dc] ?? null;
                if ($rk !== null && $ck !== null) {
                    $covered[ebr_table_cell_key($rk, $ck)] = true;
                }
            }
        }
    }
    return ['rowIds' => $rowIds, 'colIds' => $colIds, 'covered' => $covered, 'spanOf' => $spanOf];
}

/** @return list<string> */
function ebr_iter_table_anchor_keys(array $field) {
    $layout = ebr_build_table_merge_layout($field);
    $rowIds = $layout['rowIds'];
    $colIds = $layout['colIds'];
    $covered = $layout['covered'];
    $keys = [];
    foreach ($rowIds as $rid) {
        foreach ($colIds as $cid) {
            $key = ebr_table_cell_key($rid, $cid);
            if (!empty($covered[$key])) {
                continue;
            }
            $keys[] = $key;
        }
    }
    return $keys;
}

/** Matches DataEntry.jsx isTableField: explicit type or row/column grid in field JSON. */
function ebr_is_table_field(array $field) {
    $t = strtolower(trim((string) ($field['type'] ?? '')));
    if ($t === 'table') {
        return true;
    }
    $cols = $field['tableColumns'] ?? [];
    $rows = $field['tableRows'] ?? [];

    return is_array($cols) && count($cols) > 0 && is_array($rows) && count($rows) > 0;
}

function ebr_table_cell_display_label(array $field, $key) {
    $sep = EBR_TABLE_KEY_SEP;
    $i = strpos($key, $sep);
    if ($i === false) {
        return (string) $key;
    }
    $rowId = substr($key, 0, $i);
    $colId = substr($key, $i + strlen($sep));
    $rl = $rowId;
    $cl = $colId;
    foreach ($field['tableRows'] ?? [] as $r) {
        if (($r['id'] ?? '') === $rowId) {
            $lab = isset($r['label']) ? trim((string) $r['label']) : '';
            $rl = $lab !== '' ? $lab : $rowId;
            break;
        }
    }
    foreach ($field['tableColumns'] ?? [] as $c) {
        if (($c['id'] ?? '') === $colId) {
            $lab = isset($c['label']) ? trim((string) $c['label']) : '';
            $cl = $lab !== '' ? $lab : $colId;
            break;
        }
    }
    return $rl . ' / ' . $cl;
}

function ebr_table_cell_norm_string(array $cells, $key) {
    if (!array_key_exists($key, $cells)) {
        return '';
    }
    $v = $cells[$key];
    if ($v === null) {
        return '';
    }
    return trim((string) $v);
}

/** Human-readable table value for PDF (filled cells only), matching Data Entry displayFieldValue for tables. */
function ebr_format_pdf_table_value(array $field, $v) {
    $cells = ebr_normalize_table_cells($v);
    $parts = [];
    foreach (ebr_iter_table_anchor_keys($field) as $key) {
        $s = ebr_table_cell_norm_string($cells, $key);
        if ($s === '') {
            continue;
        }
        $parts[] = ebr_table_cell_display_label($field, $key) . ': ' . $s;
    }
    return empty($parts) ? '' : implode('; ', $parts);
}

/** @return list<string> */
function ebr_table_correction_changed_keys(array $field, $fromVal, $toVal) {
    $fromCells = ebr_normalize_table_cells($fromVal);
    $toCells = ebr_normalize_table_cells($toVal);
    $changed = [];
    foreach (ebr_iter_table_anchor_keys($field) as $key) {
        if (ebr_table_cell_norm_string($fromCells, $key) !== ebr_table_cell_norm_string($toCells, $key)) {
            $changed[] = $key;
        }
    }
    return $changed;
}

function ebr_format_pdf_table_correction_side(array $field, $value, array $changedKeys) {
    $cells = ebr_normalize_table_cells($value);
    $parts = [];
    foreach ($changedKeys as $key) {
        $s = ebr_table_cell_norm_string($cells, $key);
        $display = $s !== '' ? $s : '-';
        $parts[] = ebr_table_cell_display_label($field, $key) . ': ' . $display;
    }
    return empty($parts) ? '-' : implode('; ', $parts);
}

function ebr_format_pdf_correction_snippet($v, $field = null) {
    if (is_string($v) && stripos($v, 'data:image') === 0) {
        return '[signature — see system record for image]';
    }
    if ($field && ($field['type'] ?? '') === 'checkbox') {
        if ($v === null || $v === '') {
            return '';
        }
        $on = $v === true || $v === 'true' || $v === 1 || $v === '1';
        return $on ? '[x]' : '[ ]';
    }
    $s = ebr_format_pdf_value($v);
    if (strlen($s) > 120) {
        return substr($s, 0, 117) . '...';
    }
    return $s;
}

function ebr_pdf_place_signature_from_data_uri($pdf, $dataUri, $x, $y, $fw, $fh) {
    if (!is_string($dataUri) || strpos($dataUri, 'data:image') !== 0) {
        return false;
    }
    $comma = strpos($dataUri, ',');
    if ($comma === false) {
        return false;
    }
    $header = substr($dataUri, 0, $comma);
    $payload = substr($dataUri, $comma + 1);
    if (stripos($header, 'base64') === false) {
        return false;
    }
    $bin = base64_decode($payload, true);
    if ($bin === false || strlen($bin) < 24) {
        return false;
    }
    $ext = 'png';
    if (stripos($header, 'image/jpeg') !== false || stripos($header, 'image/jpg') !== false) {
        $ext = 'jpg';
    } elseif (stripos($header, 'image/gif') !== false) {
        $ext = 'gif';
    }
    $tmpFile = sys_get_temp_dir() . '/ebrsig_' . uniqid('', true) . '.' . $ext;
    if (!@file_put_contents($tmpFile, $bin)) {
        return false;
    }
    try {
        $pdf->Image($tmpFile, $x, $y, $fw, $fh);
    } catch (Exception $e) {
        @unlink($tmpFile);
        return false;
    }
    @unlink($tmpFile);
    return true;
}

/** Design px per column (matches FormBuilder DEFAULT_TABLE_COL_WIDTH). */
function ebr_table_col_design_width(array $field, int $i) {
    $cols = $field['tableColumns'] ?? [];
    if (!isset($cols[$i])) {
        return 72;
    }
    $w = (int) ($cols[$i]['width'] ?? 0);

    return $w >= 12 ? $w : 72;
}

/** Design px per row (matches FormBuilder DEFAULT_TABLE_ROW_HEIGHT). */
function ebr_table_row_design_height(array $field, int $j) {
    $rows = $field['tableRows'] ?? [];
    if (!isset($rows[$j])) {
        return 28;
    }
    $h = (int) ($rows[$j]['height'] ?? 0);

    return $h >= 12 ? $h : 28;
}

/**
 * Word-wrap text to lines that fit $maxW (current font must be set on $pdf).
 *
 * @return list<string>
 */
function ebr_pdf_wrap_lines_for_width($pdf, string $text, float $maxW) {
    $text = str_replace("\r", '', $text);
    if ($maxW < 2) {
        return $text === '' ? [] : [substr($text, 0, 1)];
    }
    $out = [];
    foreach (explode("\n", $text) as $para) {
        $para = trim($para);
        if ($para === '') {
            continue;
        }
        $words = preg_split('/\s+/u', $para, -1, PREG_SPLIT_NO_EMPTY);
        $line = '';
        foreach ($words as $w) {
            $trial = $line === '' ? $w : $line . ' ' . $w;
            if ($pdf->GetStringWidth($trial) <= $maxW) {
                $line = $trial;
            } else {
                if ($line !== '') {
                    $out[] = $line;
                    $line = '';
                }
                if ($pdf->GetStringWidth($w) <= $maxW) {
                    $line = $w;
                } else {
                    $chars = preg_split('//u', $w, -1, PREG_SPLIT_NO_EMPTY);
                    $chunk = '';
                    foreach ($chars as $ch) {
                        $t2 = $chunk . $ch;
                        if ($pdf->GetStringWidth($t2) <= $maxW) {
                            $chunk = $t2;
                        } else {
                            if ($chunk !== '') {
                                $out[] = $chunk;
                            }
                            $chunk = $ch;
                        }
                    }
                    $line = $chunk;
                }
            }
        }
        if ($line !== '') {
            $out[] = $line;
        }
    }

    return $out;
}

/**
 * Draw table as a real grid (borders, merges, column widths, row heights) like the Data Entry overlay
 * data-only grid (no separate row/column label bands).
 *
 * @param mixed $rawEff Effective value (array with cells or legacy)
 * @param float $recReservePt Space reserved at the bottom for "Rec:" line (points)
 */
function ebr_pdf_draw_table_field_in_box($pdf, array $field, $x, $y, $fw, $fh, $rawEff, $recReservePt = 0) {
    $cells = ebr_normalize_table_cells($rawEff);
    $layout = ebr_build_table_merge_layout($field);
    $rowIds = $layout['rowIds'];
    $colIds = $layout['colIds'];
    $covered = $layout['covered'];
    $spanOf = $layout['spanOf'];
    $nR = count($rowIds);
    $nC = count($colIds);
    if ($nR === 0 || $nC === 0) {
        $pdf->SetFont('Helvetica', '', 8);
        $pdf->SetXY($x, $y + 2);
        $pdf->Cell($fw, 8, '(empty table)', 0, 0, 'C');

        return;
    }

    $fhUse = max(4.0, (float) $fh - (float) $recReservePt);
    $totalW = 0.0;
    for ($i = 0; $i < $nC; $i++) {
        $totalW += (float) ebr_table_col_design_width($field, $i);
    }
    $totalH = 0.0;
    for ($j = 0; $j < $nR; $j++) {
        $totalH += (float) ebr_table_row_design_height($field, $j);
    }
    $totalW = max($totalW, 1.0);
    $totalH = max($totalH, 1.0);

    $scaleX = (float) $fw / $totalW;
    $scaleY = $fhUse / $totalH;

    $colX = [0.0];
    for ($i = 0; $i < $nC; $i++) {
        $colX[] = $colX[$i] + (float) ebr_table_col_design_width($field, $i);
    }
    $rowY = [0.0];
    for ($j = 0; $j < $nR; $j++) {
        $rowY[] = $rowY[$j] + (float) ebr_table_row_design_height($field, $j);
    }

    $sumColWidths = static function (array $field, int $ci, int $cs) {
        $s = 0.0;
        for ($k = 0; $k < $cs; $k++) {
            $s += (float) ebr_table_col_design_width($field, $ci + $k);
        }

        return $s;
    };
    $sumRowHeights = static function (array $field, int $ri, int $rs) {
        $s = 0.0;
        for ($k = 0; $k < $rs; $k++) {
            $s += (float) ebr_table_row_design_height($field, $ri + $k);
        }

        return $s;
    };

    $pdf->SetTextColor(40, 40, 40);
    foreach ($rowIds as $ri => $rid) {
        foreach ($colIds as $ci => $cid) {
            $key = ebr_table_cell_key($rid, $cid);
            if (!empty($covered[$key])) {
                continue;
            }
            $rs = 1;
            $cs = 1;
            if (isset($spanOf[$key])) {
                $rs = max(1, (int) ($spanOf[$key]['rowspan'] ?? 1));
                $cs = max(1, (int) ($spanOf[$key]['colspan'] ?? 1));
            }
            $wDesign = $sumColWidths($field, $ci, $cs);
            $hDesign = $sumRowHeights($field, $ri, $rs);
            $px = $x + $colX[$ci] * $scaleX;
            $py = $y + $rowY[$ri] * $scaleY;
            $cw = $wDesign * $scaleX;
            $ch = $hDesign * $scaleY;
            if ($cw < 0.5 || $ch < 0.5) {
                continue;
            }

            $pdf->SetFillColor(252, 252, 252);
            $pdf->SetDrawColor(210, 210, 210);
            $pdf->SetLineWidth(0.35);
            $pdf->Rect($px, $py, $cw, $ch, 'FD');

            $text = ebr_table_cell_norm_string($cells, $key);
            if ($text === '') {
                continue;
            }

            $pad = min(2.5, $cw * 0.08, $ch * 0.12);
            $innerW = max(1.0, $cw - 2 * $pad);
            $innerH = max(1.0, $ch - 2 * $pad);
            $fontSize = 7.0;
            if ($cw < 28 || $ch < 14) {
                $fontSize = 5.5;
            }
            if ($cw < 18) {
                $fontSize = 5.0;
            }
            $lineH = $fontSize * 1.12;
            $maxLines = max(1, (int) floor($innerH / $lineH));
            $pdf->SetFont('Helvetica', '', $fontSize);
            $lines = ebr_pdf_wrap_lines_for_width($pdf, $text, $innerW);
            if (count($lines) > $maxLines) {
                $lines = array_slice($lines, 0, $maxLines);
                $last = count($lines) - 1;
                if ($last >= 0) {
                    $lines[$last] = rtrim(substr($lines[$last], 0, max(0, strlen($lines[$last]) - 2))) . '…';
                }
            }
            $textH = count($lines) * $lineH;
            $startY = $py + $pad + max(0.0, ($innerH - $textH) / 2);
            $pdf->SetXY($px + $pad, $startY);
            foreach ($lines as $line) {
                $pdf->Cell($innerW, $lineH, $line, 0, 1, 'C');
            }
        }
    }
    $pdf->SetTextColor(0, 0, 0);
    $pdf->SetDrawColor(0, 0, 0);
    $pdf->SetFillColor(255, 255, 255);
}

/**
 * Match Data Entry overlay: short values bottom-centered; checkboxes centered; long / textarea / table top-centered with wrap.
 *
 * @param float $recReservePt Space reserved at bottom of box for "Rec:" line (points)
 */
function ebr_pdf_draw_field_value_in_box($pdf, $field, $x, $y, $fw, $fh, $val, $recReservePt = 0) {
    $type = $field['type'] ?? 'text';
    $fhUse = max(4.0, (float) $fh - (float) $recReservePt);
    $pdf->SetFont('Helvetica', '', 8);
    $fs = 8;
    $lineH = $fs * 1.15;

    if ($type === 'checkbox') {
        $pdf->SetXY($x, $y + ($fhUse - $lineH) / 2);
        $pdf->Cell($fw, $lineH, $val, 0, 0, 'C');
        return;
    }

    $useMultiline = ($type === 'textarea')
        || (($type === 'radio' || $type === 'multiselect') && strlen($val) > 52)
        || strlen($val) > 52;

    if ($useMultiline) {
        $fs = 8;
        $pdf->SetFont('Helvetica', '', $fs);
        $lineH = $fs * 1.12;
        $pdf->SetXY($x, $y + 1);
        $pdf->MultiCell($fw, $lineH, $val, 0, 'C');
        return;
    }

    $ty = $y + $fhUse - $lineH;
    if ($ty < $y) {
        $ty = $y;
    }
    $pdf->SetXY($x, $ty);
    $pdf->Cell($fw, $lineH, $val, 0, 0, 'C');
}

/**
 * Border + badge on each data-entry box. Badge = correction ref when the field has corrections (matches side panel);
 * otherwise sequential index on the page (all fields).
 */
function ebr_pdf_draw_field_input_frame($pdf, $x, $y, $fw, $fh, $badgeNum) {
    $pdf->SetDrawColor(102, 126, 234);
    $pdf->SetLineWidth(0.55);
    $pdf->Rect($x, $y, $fw, $fh, 'D');
    $pdf->SetLineWidth(0.35);
    $pdf->SetDrawColor(0, 0, 0);

    $badgeH = min(10.0, max(6.5, $fh * 0.4));
    $badgeW = min(17.0, max(11.0, $fw * 0.24));
    if ($badgeW > $fw - 2) {
        $badgeW = max(8.0, $fw - 2);
    }
    if ($badgeH > $fh - 2) {
        $badgeH = max(6.0, $fh - 2);
    }

    $bx = $x + 1.25;
    $by = $y + 1.25;
    $pdf->SetFillColor(102, 126, 234);
    $pdf->SetTextColor(255, 255, 255);
    $pdf->SetFont('Helvetica', 'B', 7);
    $pdf->Rect($bx, $by, $badgeW, $badgeH, 'F');
    $pdf->SetXY($bx, $by);
    $pdf->Cell($badgeW, $badgeH, (string) $badgeNum, 0, 0, 'C');
    $pdf->SetTextColor(0, 0, 0);
    $pdf->SetFillColor(255, 255, 255);
}

function ebr_pdf_format_correction_ts($iso) {
    if (!is_string($iso) || $iso === '') {
        return '';
    }
    $ts = @strtotime($iso);
    if ($ts === false) {
        return $iso;
    }
    return date('M j, Y g:i A', $ts);
}

/** Panel width (pt) from template width — same basis whether the page is widened or not. */
function ebr_pdf_corrections_panel_width_for_template($tplW) {
    return min(188.0, max(128.0, (float) $tplW * 0.265));
}

/**
 * Fields on one PDF page in reading order: top to bottom, then left to right (design x/y).
 *
 * @param list<array> $formFields
 * @return list<array>
 */
function ebr_pdf_page_fields_spatial_order(array $formFields, int $pageNo): array {
    $out = [];
    foreach ($formFields as $field) {
        if (($field['page'] ?? 1) != $pageNo) {
            continue;
        }
        $out[] = $field;
    }
    usort($out, function ($a, $b) {
        $ya = (float) ($a['y'] ?? 0);
        $yb = (float) ($b['y'] ?? 0);
        if ($ya !== $yb) {
            return $ya <=> $yb;
        }
        $xa = (float) ($a['x'] ?? 0);
        $xb = (float) ($b['x'] ?? 0);
        if ($xa !== $xb) {
            return $xa <=> $xb;
        }
        return strcmp((string) ($a['id'] ?? ''), (string) ($b['id'] ?? ''));
    });
    return $out;
}

/**
 * Right column "Corrections (this page)" panel like Data Entry (.de-corrections-panel-aside).
 * Caller should widen the page to tplW + gap + panelW + m when items is non-empty so the panel does not overlay the form.
 *
 * @param list<array{field: array, entry: array, badge: int}> $items Corrected fields only; badge = spatial index on page (1..N all fields)
 * @param float $tplW Original template width (points), used to size the panel
 * @param float $pageW Actual PDF page width (points), may be tplW + extension for the panel
 * @param float $pageH Page height (points)
 */
function ebr_pdf_draw_corrections_side_panel($pdf, array $items, $tplW, $pageW, $pageH) {
    if (empty($items)) {
        return;
    }

    $m = 10.0;
    $panelW = ebr_pdf_corrections_panel_width_for_template($tplW);
    $panelX = (float) $pageW - $m - $panelW;
    $panelY = $m;
    $panelBottom = (float) $pageH - $m;
    $pad = 8.0;
    $ix = $panelX + $pad;
    $iw = $panelW - 2 * $pad;

    $pdf->SetFillColor(255, 255, 255);
    $pdf->SetDrawColor(224, 224, 228);
    $pdf->RoundedRect($panelX, $panelY, $panelW, $panelBottom - $panelY, 8.0, '1234', 'FD');

    $pdf->SetXY($ix, $panelY + $pad);
    $pdf->SetTextColor(51, 51, 51);
    $pdf->SetFont('Helvetica', 'B', 10);
    $pdf->MultiCell($iw, 11, 'Corrections (this page)', 0, 'L');
    $pdf->SetFont('Helvetica', '', 7);
    $pdf->SetTextColor(102, 102, 102);
    $pdf->MultiCell(
        $iw,
        8,
        'Only corrections for fields on this page. Reference numbers match field badges (top to bottom, then left to right).',
        0,
        'L'
    );
    $pdf->SetTextColor(51, 51, 51);

    foreach ($items as $row) {
        $field = $row['field'];
        $ent = $row['entry'];
        $ref = (int) ($row['badge'] ?? 0);

        $yCardTop = (float) $pdf->GetY() + 5;
        if ($yCardTop > $panelBottom - 30) {
            $pdf->SetFont('Helvetica', 'I', 7);
            $pdf->SetTextColor(120, 120, 120);
            $pdf->SetXY($ix, $panelBottom - 11);
            $pdf->Cell($iw, 8, '(More corrections omitted — panel full.)', 0, 0, 'L');
            $pdf->SetTextColor(0, 0, 0);
            $pdf->SetFont('Helvetica', '', 8);
            break;
        }

        $nCor = count($ent['corrections']);
        $eff = ebr_get_effective_value($ent);
        $label = $field['label'] ?? ($field['id'] ?? 'Field');
        $tableField = ebr_is_table_field($field);
        $currentStr = $tableField ? '' : ebr_format_pdf_field_value($field, $eff);
        $longCurrent = !$tableField && strlen($currentStr) > 45;
        $baseCard = $tableField ? 22.0 : 26.0;
        $estH = min($panelBottom - $yCardTop - 2, max(38.0, $baseCard + $nCor * 12.0 + ($longCurrent ? 10.0 : 0.0)));

        $cardR = min(5.0, $iw / 2, $estH / 2);
        $pdf->SetFillColor(248, 249, 250);
        $pdf->SetDrawColor(237, 237, 240);
        $pdf->RoundedRect($ix, $yCardTop, $iw, $estH, $cardR, '1234', 'FD');

        $innerLeft = $ix + 5;
        $innerW = $iw - 10;
        $pdf->SetXY($innerLeft, $yCardTop + 5);

        $badgeW = 16.0;
        $pdf->SetFillColor(102, 126, 234);
        $pdf->SetTextColor(255, 255, 255);
        $pdf->SetFont('Helvetica', 'B', 8);
        $pdf->Cell($badgeW, 9, (string) $ref, 0, 0, 'C', true);

        $pdf->SetTextColor(51, 51, 51);
        $pdf->SetFont('Helvetica', 'B', 8);
        $pdf->Cell($innerW - $badgeW, 9, ' ' . $label, 0, 1, 'L');

        if (!$tableField) {
            $pdf->SetX($innerLeft);
            $pdf->SetFont('Helvetica', '', 7);
            $pdf->SetTextColor(85, 85, 85);
            $pdf->MultiCell($innerW, 7, 'Current: ' . $currentStr, 0, 'L');
        }

        foreach ($ent['corrections'] as $c) {
            if ($pdf->GetY() > $yCardTop + $estH - 4) {
                break;
            }
            if ($tableField) {
                $deltaKeys = ebr_table_correction_changed_keys($field, $c['from'] ?? null, $c['to'] ?? null);
                $from = ebr_format_pdf_table_correction_side($field, $c['from'] ?? null, $deltaKeys);
                $to = ebr_format_pdf_table_correction_side($field, $c['to'] ?? null, $deltaKeys);
            } else {
                $from = ebr_format_pdf_correction_snippet($c['from'] ?? '', $field);
                $to = ebr_format_pdf_correction_snippet($c['to'] ?? '', $field);
            }
            $by = $c['by'] ?? '';
            $at = ebr_pdf_format_correction_ts($c['at'] ?? '');
            $line = $from . ' -> ' . $to;
            if ($by !== '' || $at !== '') {
                $line .= ' (' . $by . ($at !== '' ? ', ' . $at : '') . ')';
            }
            $pdf->SetX($innerLeft + 3);
            $pdf->SetTextColor(85, 85, 85);
            $pdf->MultiCell($innerW - 3, 7, '- ' . $line, 0, 'L');
        }

        $pdf->SetDrawColor(102, 126, 234);
        $pdf->SetLineWidth(1.2);
        $stripeInset = max(2.5, $cardR * 0.85);
        $pdf->Line($ix + 1.2, $yCardTop + $stripeInset, $ix + 1.2, $yCardTop + $estH - $stripeInset);
        $pdf->SetLineWidth(0.35);
        $pdf->SetDrawColor(0, 0, 0);
        $pdf->SetTextColor(51, 51, 51);

        $pdf->SetXY($ix, $yCardTop + $estH + 3);
    }

    $pdf->SetTextColor(0, 0, 0);
    $pdf->SetFillColor(255, 255, 255);
    $pdf->SetFont('Helvetica', '', 8);
}

/**
 * @param array $form Form config (fields, pdfFile)
 * @param array $formData Field id => audit entry or raw value
 * @param array $batch Batch metadata (title, completedSignOffBy, completedSignOffAt, completedAt)
 * @return string Raw PDF bytes
 */
function ebr_build_batch_pdf_binary($form, $formData, $batch) {
    if (!file_exists(__DIR__ . '/../vendor/autoload.php')) {
        throw new Exception(
            'PDF export requires Composer dependencies. From the project root run: composer install'
        );
    }
    require_once __DIR__ . '/../vendor/autoload.php';
    require_once __DIR__ . '/EbrFpdi.php';

    $templatePath = null;
    try {
    $templatePath = ebr_db_pdf_template_materialize_to_temp((string) ($form['pdfFile'] ?? ''));
    if ($templatePath === null || !is_readable($templatePath)) {
        throw new Exception('Template PDF not found');
    }

    $DESIGN_SCALE = 1.5;

    $effective = [];
    foreach ($form['fields'] as $field) {
        $id = $field['id'];
        $entry = $formData[$id] ?? null;
        $effective[$id] = ebr_get_effective_value($entry);
    }

    // Use points: template size from FPDI and field coords (design / DESIGN_SCALE) are PDF points; default FPDF mm would mis-size pages and place text off-page.
    $pdf = new EbrFpdi('P', 'pt');
    $pageCount = $pdf->setSourceFile($templatePath);

    for ($pageNo = 1; $pageNo <= $pageCount; $pageNo++) {
        $tplId = $pdf->importPage($pageNo);
        $size = $pdf->getTemplateSize($tplId);
        $w = $size['width'];
        $h = $size['height'];
        $orientation = ($w > $h) ? 'L' : 'P';
        $tplW = $w;
        $tplH = $h;

        $pageFields = ebr_pdf_page_fields_spatial_order($form['fields'], $pageNo);
        $spatialBadgeByFieldId = [];
        foreach ($pageFields as $i => $field) {
            $spatialBadgeByFieldId[$field['id']] = $i + 1;
        }

        $panelItems = [];
        foreach ($pageFields as $field) {
            $id = $field['id'];
            $ent = $formData[$id] ?? null;
            if (is_array($ent) && !empty($ent['corrections']) && is_array($ent['corrections'])) {
                $panelItems[] = [
                    'field' => $field,
                    'entry' => $ent,
                    'badge' => $spatialBadgeByFieldId[$id],
                ];
            }
        }

        $panelMargin = 10.0;
        $panelGap = 12.0;
        $corrPanelW = ebr_pdf_corrections_panel_width_for_template($tplW);
        $pageW = empty($panelItems)
            ? $tplW
            : ($tplW + $panelGap + $corrPanelW + $panelMargin);

        $pdf->AddPage($orientation, [$pageW, $tplH]);
        $pdf->useTemplate($tplId);
        $pdf->SetAutoPageBreak(false);

        foreach ($pageFields as $field) {
            $id = $field['id'];
            $rawEff = $effective[$id] ?? '';
            $ent = $formData[$id] ?? null;

            $x = ($field['x'] ?? 0) / $DESIGN_SCALE;
            $y = ($field['y'] ?? 0) / $DESIGN_SCALE;
            $fw = ($field['width'] ?? 100) / $DESIGN_SCALE;
            $fh = ($field['height'] ?? 20) / $DESIGN_SCALE;

            $pdf->SetFont('Helvetica', '', 8);
            $pdf->SetXY($x, $y);

            $isSig = ($field['type'] ?? '') === 'signature';
            $sigOk = $isSig && is_string($rawEff) && strpos($rawEff, 'data:image') === 0
                && ebr_pdf_place_signature_from_data_uri($pdf, $rawEff, $x, $y, $fw, $fh);

            if (!$sigOk) {
                $recReserve = (is_array($ent) && !empty($ent['recordedBy'])) ? 9.0 : 0.0;
                if (ebr_is_table_field($field)) {
                    ebr_pdf_draw_table_field_in_box($pdf, $field, $x, $y, $fw, $fh, $rawEff, $recReserve);
                } else {
                    $val = ebr_format_pdf_field_value($field, $rawEff);
                    ebr_pdf_draw_field_value_in_box($pdf, $field, $x, $y, $fw, $fh, $val, $recReserve);
                }
                if (is_array($ent) && !empty($ent['recordedBy'])) {
                    $pdf->SetFont('Helvetica', 'I', 6);
                    $pdf->SetXY($x, $y + $fh - 8);
                    $pdf->Cell($fw, 8, 'Rec: ' . ebr_format_pdf_value($ent['recordedBy']), 0, 0, 'C');
                    $pdf->SetFont('Helvetica', '', 8);
                }
            } elseif (is_array($ent) && !empty($ent['recordedBy'])) {
                $pdf->SetXY($x, $y + $fh);
                $pdf->SetFont('Helvetica', 'I', 6);
                $pdf->Cell($fw, 10, 'Rec: ' . ebr_format_pdf_value($ent['recordedBy']), 0, 0, 'C');
                $pdf->SetFont('Helvetica', '', 8);
            }

            $badgeNum = $spatialBadgeByFieldId[$id];
            ebr_pdf_draw_field_input_frame($pdf, $x, $y, $fw, $fh, $badgeNum);
        }

        ebr_pdf_draw_corrections_side_panel($pdf, $panelItems, $tplW, $pageW, $tplH);

        $pdf->SetAutoPageBreak(true, 56.7);
    }

    if (!empty($batch['completedSignOffBy'])) {
        $pdf->AddPage('P', 'A4');
        $pdf->SetFont('Helvetica', 'B', 12);
        $pdf->Cell(0, 10, 'Batch record sign-off', 0, 1);
        $pdf->SetFont('Helvetica', '', 10);
        $sigAt = $batch['completedSignOffAt'] ?? $batch['completedAt'] ?? '';
        $pdf->Cell(0, 8, 'Secondary reviewer sign-off: ' . ebr_format_pdf_value($batch['completedSignOffBy']), 0, 1);
        $pdf->Cell(0, 8, 'Signed off at: ' . ebr_format_pdf_value($sigAt), 0, 1);
    }

    return $pdf->Output('S');
    } finally {
        ebr_db_pdf_template_unlink_temp($templatePath);
    }
}
