"""Stage A — geometry extraction.

Pure geometry. No semantics, no field-type classification.

Per page we produce a `PageGeometry` containing:
  * Axis-aligned horizontal/vertical rules (vector first, OpenCV fallback)
  * Tables (grids of H x V rules) with their cell layout, supporting
    merged cells (a cell may span >1 row and/or >1 col)
  * Standalone underlines (H lines that are not part of any table)
  * Standalone closed boxes (4-sided rectangles outside tables)
  * Checkbox candidates (small near-square boxes)
  * Page words (pre-fetched for downstream label search)

All coordinates are PDF points (72 DPI, origin top-left, y downward) — the
same coordinate space PyMuPDF exposes via `page.rect`. Image-space
artifacts (Hough lines, contours) are converted to PDF points before
they reach the public structures here.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

import cv2
import fitz
import numpy as np


# ---------- Dataclasses --------------------------------------------------- #


@dataclass
class HLine:
    """Horizontal rule in PDF points."""
    x0: float
    x1: float
    y: float
    weight: float = 1.0  # length / page_w, used as tie-breaker


@dataclass
class VLine:
    """Vertical rule in PDF points."""
    y0: float
    y1: float
    x: float
    weight: float = 1.0


@dataclass
class Rect:
    x: float
    y: float
    w: float
    h: float

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def y1(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    def as_tuple(self) -> tuple[float, float, float, float]:
        return (self.x, self.y, self.w, self.h)


@dataclass
class Cell:
    table_id: int
    row: int
    col: int
    row_span: int
    col_span: int
    bbox: Rect


@dataclass
class Table:
    id: int
    bbox: Rect
    row_bounds: list[float]  # sorted y positions, length = rows + 1
    col_bounds: list[float]  # sorted x positions, length = cols + 1
    cells: list[Cell]
    borderless: bool = False  # True when columns were inferred from text


@dataclass
class PageGeometry:
    page_num: int  # 1-indexed
    page_w: float
    page_h: float
    h_lines: list[HLine]
    v_lines: list[VLine]
    tables: list[Table] = field(default_factory=list)
    standalone_underlines: list[HLine] = field(default_factory=list)
    standalone_boxes: list[Rect] = field(default_factory=list)
    checkbox_candidates: list[Rect] = field(default_factory=list)
    words: list[tuple[float, float, float, float, str]] = field(default_factory=list)


# ---------- Tunables ------------------------------------------------------ #

# How close two parallel lines must be to fuse into one rule.
H_FUSE_TOL_PT = 1.6
V_FUSE_TOL_PT = 1.6

# Minimum line length to be considered a rule (in PDF points).
MIN_H_LEN_PT = 16.0
MIN_V_LEN_PT = 10.0

# Tolerance for treating two H/V line endpoints as "touching" at a corner.
JOIN_TOL_PT = 4.0


# ---------- Vector line extraction --------------------------------------- #


def _vector_lines(page: fitz.Page) -> tuple[list[HLine], list[VLine]]:
    """Extract H/V rules from the page's vector drawings.

    PyMuPDF returns line segments and rectangles. For batch-record PDFs
    authored in Word/Adobe, table borders are vector strokes, so this is
    the primary source. Rectangles are decomposed into their 4 sides.
    """
    h: list[HLine] = []
    v: list[VLine] = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return h, v

    page_w = float(page.rect.width)

    def _add_seg(x0: float, y0: float, x1: float, y1: float) -> None:
        dx = abs(x1 - x0)
        dy = abs(y1 - y0)
        if dy <= 0.6 and dx >= MIN_H_LEN_PT:
            h.append(HLine(
                x0=min(x0, x1),
                x1=max(x0, x1),
                y=(y0 + y1) / 2,
                weight=dx / max(1.0, page_w),
            ))
        elif dx <= 0.6 and dy >= MIN_V_LEN_PT:
            v.append(VLine(
                y0=min(y0, y1),
                y1=max(y0, y1),
                x=(x0 + x1) / 2,
                weight=dy / max(1.0, page_w),
            ))

    for d in drawings:
        for item in d.get("items", []):
            kind = item[0]
            if kind == "l":  # line
                p0, p1 = item[1], item[2]
                _add_seg(p0.x, p0.y, p1.x, p1.y)
            elif kind == "re":  # rectangle
                r = item[1]
                _add_seg(r.x0, r.y0, r.x1, r.y0)  # top
                _add_seg(r.x0, r.y1, r.x1, r.y1)  # bottom
                _add_seg(r.x0, r.y0, r.x0, r.y1)  # left
                _add_seg(r.x1, r.y0, r.x1, r.y1)  # right
    return h, v


# ---------- Raster fallback (Hough) -------------------------------------- #


def _hough_lines_px_to_pt(
    gray: np.ndarray,
    page_w: float,
    page_h: float,
) -> tuple[list[HLine], list[VLine]]:
    """Find H/V lines via Hough on the page raster, return in PDF points.

    Used when vector drawings are sparse (scanned PDFs). The raster is
    expected to be rendered at the same orientation as the page rect.
    Morphological line extraction is used in tandem because Canny+Hough
    misses thin, low-contrast borders that real table grids often use.
    """
    h_out: list[HLine] = []
    v_out: list[VLine] = []
    if gray is None or gray.size == 0:
        return h_out, v_out
    ph, pw = gray.shape[:2]
    sx = page_w / max(1, pw)
    sy = page_h / max(1, ph)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    edges = cv2.Canny(blur, 40, 120, apertureSize=3)
    min_len_px = max(int(pw * 0.05), 20)
    lines = cv2.HoughLinesP(
        edges,
        rho=1,
        theta=np.pi / 180,
        threshold=max(24, min_len_px // 4),
        minLineLength=min_len_px,
        maxLineGap=12,
    )
    if lines is not None:
        for ln in lines:
            x0, y0, x1, y1 = ln[0]
            dx_px = abs(x1 - x0)
            dy_px = abs(y1 - y0)
            if dy_px <= 3 and dx_px >= min_len_px:
                x0p = float(min(x0, x1)) * sx
                x1p = float(max(x0, x1)) * sx
                yp = float((y0 + y1) / 2) * sy
                h_out.append(HLine(x0=x0p, x1=x1p, y=yp, weight=(x1p - x0p) / max(1.0, page_w)))
            elif dx_px <= 3 and dy_px >= min_len_px * 0.4:
                y0p = float(min(y0, y1)) * sy
                y1p = float(max(y0, y1)) * sy
                xp = float((x0 + x1) / 2) * sx
                v_out.append(VLine(y0=y0p, y1=y1p, x=xp, weight=(y1p - y0p) / max(1.0, page_w)))

    # Add morphological line extraction — picks up thin/faint borders
    # that Canny edge detection swallows.
    m_h, m_v = _morph_lines_px_to_pt(gray, page_w, page_h)
    h_out.extend(m_h)
    v_out.extend(m_v)
    return h_out, v_out


def _morph_lines_px_to_pt(
    gray: np.ndarray,
    page_w: float,
    page_h: float,
) -> tuple[list[HLine], list[VLine]]:
    """Detect H/V lines via vertical/horizontal morphology.

    Adaptive threshold + open with a long thin kernel isolates only
    stretched-out vertical/horizontal pixels — i.e. ruled borders. This
    catches the thin column dividers that Canny+Hough misses.
    """
    h_out: list[HLine] = []
    v_out: list[VLine] = []
    if gray is None or gray.size == 0:
        return h_out, v_out
    ph_img, pw_img = gray.shape[:2]
    sx = page_w / max(1, pw_img)
    sy = page_h / max(1, ph_img)
    # OTSU global threshold is cleaner for ruled borders than adaptive
    # — adaptive marks text blobs as foreground too, which then forms
    # spurious vertical/horizontal bars after morph opening.
    _, bw = cv2.threshold(
        gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU,
    )
    v_kernel_h = max(15, ph_img // 70)
    h_kernel_w = max(15, pw_img // 70)
    vert = cv2.morphologyEx(
        bw, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (1, v_kernel_h)),
        iterations=1,
    )
    horiz = cv2.morphologyEx(
        bw, cv2.MORPH_OPEN,
        cv2.getStructuringElement(cv2.MORPH_RECT, (h_kernel_w, 1)),
        iterations=1,
    )

    for c in cv2.findContours(vert, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(c)
        if w > 4 or h < v_kernel_h - 2:
            continue
        v_out.append(VLine(
            x=(x + w / 2) * sx,
            y0=y * sy,
            y1=(y + h) * sy,
            weight=(h * sy) / max(1.0, page_h),
        ))

    for c in cv2.findContours(horiz, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        x, y, w, h = cv2.boundingRect(c)
        if h > 4 or w < h_kernel_w - 2:
            continue
        h_out.append(HLine(
            x0=x * sx,
            x1=(x + w) * sx,
            y=(y + h / 2) * sy,
            weight=(w * sx) / max(1.0, page_w),
        ))
    return h_out, v_out


# ---------- Line fusion --------------------------------------------------- #


def _fuse_h_lines(lines: list[HLine], tol: float = H_FUSE_TOL_PT) -> list[HLine]:
    """Merge collinear/parallel-adjacent horizontal segments at the same y."""
    if not lines:
        return []
    lines = sorted(lines, key=lambda l: (l.y, l.x0))
    fused: list[HLine] = []
    for ln in lines:
        merged = False
        for k in fused:
            if abs(k.y - ln.y) <= tol:
                # x-overlap or near-touching → fuse
                if ln.x0 <= k.x1 + JOIN_TOL_PT and ln.x1 >= k.x0 - JOIN_TOL_PT:
                    k.x0 = min(k.x0, ln.x0)
                    k.x1 = max(k.x1, ln.x1)
                    k.weight = max(k.weight, ln.weight)
                    # average y, weighted by line length
                    k.y = (k.y + ln.y) / 2
                    merged = True
                    break
        if not merged:
            fused.append(HLine(x0=ln.x0, x1=ln.x1, y=ln.y, weight=ln.weight))
    # Remove lines that are too short after fusion
    return [l for l in fused if (l.x1 - l.x0) >= MIN_H_LEN_PT]


def _fuse_v_lines(lines: list[VLine], tol: float = V_FUSE_TOL_PT) -> list[VLine]:
    if not lines:
        return []
    lines = sorted(lines, key=lambda l: (l.x, l.y0))
    fused: list[VLine] = []
    for ln in lines:
        merged = False
        for k in fused:
            if abs(k.x - ln.x) <= tol:
                if ln.y0 <= k.y1 + JOIN_TOL_PT and ln.y1 >= k.y0 - JOIN_TOL_PT:
                    k.y0 = min(k.y0, ln.y0)
                    k.y1 = max(k.y1, ln.y1)
                    k.weight = max(k.weight, ln.weight)
                    k.x = (k.x + ln.x) / 2
                    merged = True
                    break
        if not merged:
            fused.append(VLine(y0=ln.y0, y1=ln.y1, x=ln.x, weight=ln.weight))
    return [l for l in fused if (l.y1 - l.y0) >= MIN_V_LEN_PT]


# ---------- Words --------------------------------------------------------- #


def _words(page: fitz.Page) -> list[tuple[float, float, float, float, str]]:
    out: list[tuple[float, float, float, float, str]] = []
    try:
        ws = page.get_text("words") or []
    except Exception:
        return out
    for w in ws:
        if len(w) < 5:
            continue
        x0, y0, x1, y1, txt = float(w[0]), float(w[1]), float(w[2]), float(w[3]), str(w[4])
        t = txt.strip()
        if t:
            out.append((x0, y0, x1, y1, t))
    return out


# ---------- Table detection ---------------------------------------------- #


def _h_v_at_point(
    h_lines: list[HLine], v_lines: list[VLine], x: float, y: float, tol: float = JOIN_TOL_PT,
) -> bool:
    """True if both an H and V line pass within `tol` of point (x,y)."""
    h_hit = any(
        abs(h.y - y) <= tol and h.x0 - tol <= x <= h.x1 + tol for h in h_lines
    )
    if not h_hit:
        return False
    return any(
        abs(v.x - x) <= tol and v.y0 - tol <= y <= v.y1 + tol for v in v_lines
    )


def _group_into_tables(
    h_lines: list[HLine],
    v_lines: list[VLine],
) -> list[tuple[list[HLine], list[VLine]]]:
    """Group H and V lines into connected table clusters.

    A cluster requires that lines share a bounding region where at least
    one H endpoint sits near a V line (intersection). We expand greedily.
    """
    if not h_lines or not v_lines:
        return []

    # Build all "intersections" first.
    intersections: list[tuple[int, int]] = []  # (h_idx, v_idx)
    for hi, h in enumerate(h_lines):
        for vi, v in enumerate(v_lines):
            if v.x < h.x0 - JOIN_TOL_PT or v.x > h.x1 + JOIN_TOL_PT:
                continue
            if h.y < v.y0 - JOIN_TOL_PT or h.y > v.y1 + JOIN_TOL_PT:
                continue
            intersections.append((hi, vi))

    if not intersections:
        return []

    # Union-find over (H,V) pairs.
    h_parent = list(range(len(h_lines)))
    v_parent = list(range(len(v_lines)))

    def hfind(i: int) -> int:
        while h_parent[i] != i:
            h_parent[i] = h_parent[h_parent[i]]
            i = h_parent[i]
        return i

    def vfind(i: int) -> int:
        while v_parent[i] != i:
            v_parent[i] = v_parent[v_parent[i]]
            i = v_parent[i]
        return i

    # Cross-link: use a high offset so the two sets don't collide.
    H_OFFSET = 0
    V_OFFSET = len(h_lines)
    parent = list(range(len(h_lines) + len(v_lines)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for hi, vi in intersections:
        union(H_OFFSET + hi, V_OFFSET + vi)

    # Collect connected components, each must have ≥2 H and ≥2 V.
    groups: dict[int, tuple[list[int], list[int]]] = {}
    for hi in range(len(h_lines)):
        root = find(H_OFFSET + hi)
        groups.setdefault(root, ([], []))[0].append(hi)
    for vi in range(len(v_lines)):
        root = find(V_OFFSET + vi)
        groups.setdefault(root, ([], []))[1].append(vi)

    out: list[tuple[list[HLine], list[VLine]]] = []
    for root, (his, vis) in groups.items():
        if len(his) < 2 or len(vis) < 2:
            continue
        out.append(([h_lines[i] for i in his], [v_lines[i] for i in vis]))
    return out


def _line_passes_segment(h: HLine, x_a: float, x_b: float, tol: float = JOIN_TOL_PT) -> bool:
    """True if a horizontal line covers the x range [x_a, x_b]."""
    return h.x0 <= min(x_a, x_b) + tol and h.x1 >= max(x_a, x_b) - tol


def _vline_passes_segment(v: VLine, y_a: float, y_b: float, tol: float = JOIN_TOL_PT) -> bool:
    return v.y0 <= min(y_a, y_b) + tol and v.y1 >= max(y_a, y_b) - tol


def _has_h_between(h_lines: list[HLine], y: float, x_a: float, x_b: float, tol: float = JOIN_TOL_PT) -> bool:
    """True when an H line at y covers [x_a, x_b]."""
    return any(abs(h.y - y) <= tol and _line_passes_segment(h, x_a, x_b, tol) for h in h_lines)


def _has_v_between(v_lines: list[VLine], x: float, y_a: float, y_b: float, tol: float = JOIN_TOL_PT) -> bool:
    return any(abs(v.x - x) <= tol and _vline_passes_segment(v, y_a, y_b, tol) for v in v_lines)


def _build_grids_from_cluster(
    h_lines: list[HLine],
    v_lines: list[VLine],
    starting_table_id: int,
) -> list[Table]:
    """Build one or more Tables from a cluster of intersecting H/V lines.

    A single line cluster (from line union-find) can visually contain
    *multiple* distinct tables — they share boundary lines so the union
    smashes them together. We split the cluster by analysing which
    V-lines are active in each row band: sub-tables differ in their
    column structure (vertical dividers above the seam are not the same
    set as below it).
    """
    if len(h_lines) < 2 or len(v_lines) < 2:
        return []

    ys = sorted({round(h.y, 1) for h in h_lines})
    xs = sorted({round(v.x, 1) for v in v_lines})
    ys = _dedup_floats(ys, tol=JOIN_TOL_PT)
    xs = _dedup_floats(xs, tol=JOIN_TOL_PT)
    if len(ys) < 2 or len(xs) < 2:
        return []

    # Per-row-band V-line set (which vertical dividers are active here).
    rows = len(ys) - 1
    row_vsets: list[frozenset[float]] = []
    for r in range(rows):
        y_mid = (ys[r] + ys[r + 1]) / 2
        vset = frozenset(
            round(v.x, 1) for v in v_lines
            if v.y0 - JOIN_TOL_PT <= y_mid <= v.y1 + JOIN_TOL_PT
        )
        row_vsets.append(vset)

    # Partition consecutive rows into sub-tables by V-set similarity.
    sub_ranges = _partition_rows_by_vset(row_vsets)
    if not sub_ranges:
        return []

    raw_tables: list[Table] = []
    next_id = starting_table_id
    for r_start, r_end in sub_ranges:
        y_top = ys[r_start]
        y_bot = ys[r_end]
        # Include V-lines that overlap the band at all — the per-cell
        # `_has_v_between` check rejects ones that don't span individual
        # rows. This keeps inner column dividers that don't fully reach
        # the band's outer y-bounds (typical for inset table grids).
        sub_vs = [
            v for v in v_lines
            if min(v.y1, y_bot) > max(v.y0, y_top)
        ]
        if len(sub_vs) < 2:
            continue
        sub_hs = [
            h for h in h_lines
            if y_top - JOIN_TOL_PT <= h.y <= y_bot + JOIN_TOL_PT
        ]
        if len(sub_hs) < 2:
            continue
        t = _build_single_grid(sub_hs, sub_vs, next_id)
        if t is None:
            continue
        raw_tables.append(t)
        next_id += 1
    # Drop "fake" sub-tables that aren't really grids. We use two
    # filters:
    #   1. Cell coverage of the base grid (merged-aware) ≥ 60%.
    #   2. At least one *interior* V divider (i.e. not the outermost
    #      column borders, which are often page edges) must span ≥ 70%
    #      of the table's height. Without this, the region is usually a
    #      stack of "Label: ____" pairs framed by the page borders, and
    #      standalone underline detection handles it better.
    tables: list[Table] = []
    for t in raw_tables:
        num_cols = len(t.col_bounds) - 1
        num_rows = len(t.row_bounds) - 1
        if num_cols < 2:
            continue
        covered = sum(c.row_span * c.col_span for c in t.cells)
        coverage = covered / max(1, num_rows * num_cols)
        if coverage < 0.6:
            continue
        table_h = t.row_bounds[-1] - t.row_bounds[0]
        if table_h <= 0:
            continue
        interior_xs = t.col_bounds[1:-1]
        if interior_xs:
            y_top = t.row_bounds[0]
            y_bot = t.row_bounds[-1]
            best_span = 0.0
            for x in interior_xs:
                for v in v_lines:
                    if abs(v.x - x) > JOIN_TOL_PT:
                        continue
                    overlap = max(0.0, min(v.y1, y_bot) - max(v.y0, y_top))
                    if overlap > best_span:
                        best_span = overlap
            if best_span / table_h < 0.7:
                continue
        tables.append(t)
    return tables


def _partition_rows_by_vset(
    row_vsets: list[frozenset[float]],
    min_jaccard: float = 0.5,
) -> list[tuple[int, int]]:
    """Group consecutive rows into runs that share a similar V-line set.

    A boundary between sub-tables happens whenever the active V-line set
    changes substantially. The simplest signal is Jaccard similarity:
    if two consecutive rows share fewer than half their V-lines, they
    belong to different sub-tables.
    """
    if not row_vsets:
        return []
    sub_ranges: list[tuple[int, int]] = []
    start = 0
    for r in range(1, len(row_vsets)):
        prev = row_vsets[r - 1]
        curr = row_vsets[r]
        if not prev or not curr:
            similar = (prev == curr)
        else:
            inter = len(prev & curr)
            union = len(prev | curr)
            similar = (inter / union) >= min_jaccard if union else True
        if not similar:
            if start < r:
                sub_ranges.append((start, r))
            start = r
    if start < len(row_vsets):
        sub_ranges.append((start, len(row_vsets)))
    # row indices in row_vsets correspond to (row, row+1) y bounds. The
    # range covers row bands [start, end-1]; the y range is ys[start..end].
    return sub_ranges


def _filter_real_row_bounds(
    ys: list[float],
    xs: list[float],
    v_lines: list[VLine],
) -> list[float]:
    """Drop y bounds where most interior V dividers don't actually cross.

    A real row boundary is one where MORE THAN HALF of the table's
    interior V dividers extend through that y. Boundaries where the
    dividers stop short are seam artefacts of raster line detection —
    including them creates thin rows whose cells merge horizontally
    because most column borders are missing.
    """
    if len(xs) < 3:
        return ys
    interior_xs = xs[1:-1]
    if not interior_xs:
        return ys
    real: list[float] = []
    for y in ys:
        crossed = 0
        for x in interior_xs:
            for v in v_lines:
                if abs(v.x - x) > JOIN_TOL_PT:
                    continue
                if v.y0 <= y + JOIN_TOL_PT and v.y1 >= y - JOIN_TOL_PT:
                    crossed += 1
                    break
        if crossed * 2 > len(interior_xs):
            real.append(y)
    return real


def _build_single_grid(
    h_lines: list[HLine],
    v_lines: list[VLine],
    table_id: int,
) -> Table | None:
    """Build a single Table from a (filtered) set of H/V lines.

    Row boundaries are restricted to H lines that span (most of) the
    table's full width — interior decorative rules within a cell would
    otherwise fragment the table into spurious rows.
    Cells may span multiple base rows/cols when an internal H or V
    border is missing (merged cells).
    """
    if len(h_lines) < 2 or len(v_lines) < 2:
        return None
    xs = sorted({round(v.x, 1) for v in v_lines})
    xs = _dedup_floats(xs, tol=JOIN_TOL_PT)
    if len(xs) < 2:
        return None
    table_x_min, table_x_max = xs[0], xs[-1]
    # Keep only H lines that reach (within tolerance) both ends of the
    # table's x range. Other H lines stay available for sub-cell
    # treatment but never define a row.
    full_width_hs = [
        h for h in h_lines
        if h.x0 <= table_x_min + JOIN_TOL_PT * 2
        and h.x1 >= table_x_max - JOIN_TOL_PT * 2
    ]
    if len(full_width_hs) < 2:
        return None
    ys = sorted({round(h.y, 1) for h in full_width_hs})
    ys = _dedup_floats(ys, tol=JOIN_TOL_PT)
    if len(ys) < 2:
        return None

    # Keep only y values that are crossed by MORE THAN HALF of the
    # interior V dividers. Boundaries where most dividers don't reach
    # are seam artefacts of raster line detection — including them
    # creates thin "rows" whose cells merge horizontally because most
    # column borders aren't there.
    ys = _filter_real_row_bounds(ys, xs, v_lines)
    if len(ys) < 2:
        return None

    bbox = Rect(x=xs[0], y=ys[0], w=xs[-1] - xs[0], h=ys[-1] - ys[0])
    rows = len(ys) - 1
    cols = len(xs) - 1
    present = [[False] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            x_l, x_r = xs[c], xs[c + 1]
            y_t, y_b = ys[r], ys[r + 1]
            top = _has_h_between(h_lines, y_t, x_l, x_r)
            bot = _has_h_between(h_lines, y_b, x_l, x_r)
            left = _has_v_between(v_lines, x_l, y_t, y_b)
            right = _has_v_between(v_lines, x_r, y_t, y_b)
            present[r][c] = top and bot and left and right

    cells: list[Cell] = []
    consumed = [[False] * cols for _ in range(rows)]
    for r in range(rows):
        for c in range(cols):
            if consumed[r][c]:
                continue
            if not present[r][c]:
                row_span, col_span = _measure_merged_span(
                    h_lines, v_lines, xs, ys, r, c, present, consumed
                )
                if row_span == 0 or col_span == 0:
                    continue
            else:
                row_span, col_span = 1, 1
            while c + col_span < cols and not consumed[r][c + col_span]:
                x_inner = xs[c + col_span]
                if _has_v_between(v_lines, x_inner, ys[r], ys[r + 1]):
                    break
                col_span += 1
            while r + row_span < rows and not consumed[r + row_span][c]:
                y_inner = ys[r + row_span]
                if _has_h_between(h_lines, y_inner, xs[c], xs[c + col_span]):
                    break
                row_span += 1
            for rr in range(r, r + row_span):
                for cc in range(c, c + col_span):
                    consumed[rr][cc] = True
            bx = xs[c]
            by = ys[r]
            bw = xs[c + col_span] - bx
            bh = ys[r + row_span] - by
            cells.append(Cell(
                table_id=table_id, row=r, col=c,
                row_span=row_span, col_span=col_span,
                bbox=Rect(x=bx, y=by, w=bw, h=bh),
            ))
    if not cells:
        return None
    return Table(
        id=table_id, bbox=bbox,
        row_bounds=ys, col_bounds=xs,
        cells=cells, borderless=False,
    )


def _group_cells_by_adjacency(cells: list[Cell]) -> list[list[Cell]]:
    """Union-find over cells using shared-border adjacency.

    Two cells are adjacent when they share a horizontal or vertical
    border within JOIN_TOL_PT and the perpendicular ranges overlap.
    """
    n = len(cells)
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    tol = JOIN_TOL_PT
    for i in range(n):
        a = cells[i].bbox
        for j in range(i + 1, n):
            b = cells[j].bbox
            # Vertical adjacency: a above b, or b above a.
            if abs(a.y1 - b.y) <= tol or abs(b.y1 - a.y) <= tol:
                if min(a.x1, b.x1) - max(a.x, b.x) > tol:
                    union(i, j)
                    continue
            # Horizontal adjacency.
            if abs(a.x1 - b.x) <= tol or abs(b.x1 - a.x) <= tol:
                if min(a.y1, b.y1) - max(a.y, b.y) > tol:
                    union(i, j)
                    continue

    groups: dict[int, list[Cell]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(cells[i])
    return list(groups.values())


def _table_from_cell_group(cells: list[Cell], table_id: int) -> Table | None:
    """Build a Table object from an adjacency group of cells."""
    if not cells:
        return None
    # Compute local row/col indices relative to this sub-table by
    # re-clustering the boundary positions among this group's cells.
    ys: list[float] = sorted({round(c.bbox.y, 1) for c in cells} |
                             {round(c.bbox.y1, 1) for c in cells})
    xs: list[float] = sorted({round(c.bbox.x, 1) for c in cells} |
                             {round(c.bbox.x1, 1) for c in cells})
    ys = _dedup_floats(ys, tol=JOIN_TOL_PT)
    xs = _dedup_floats(xs, tol=JOIN_TOL_PT)
    if len(ys) < 2 or len(xs) < 2:
        return None

    def _idx(values: list[float], target: float) -> int:
        return min(range(len(values)), key=lambda k: abs(values[k] - target))

    new_cells: list[Cell] = []
    for c in cells:
        r0 = _idx(ys, c.bbox.y)
        r1 = _idx(ys, c.bbox.y1)
        c0 = _idx(xs, c.bbox.x)
        c1 = _idx(xs, c.bbox.x1)
        new_cells.append(Cell(
            table_id=table_id,
            row=r0,
            col=c0,
            row_span=max(1, r1 - r0),
            col_span=max(1, c1 - c0),
            bbox=c.bbox,
        ))
    bbox = Rect(x=xs[0], y=ys[0], w=xs[-1] - xs[0], h=ys[-1] - ys[0])
    return Table(
        id=table_id,
        bbox=bbox,
        row_bounds=ys,
        col_bounds=xs,
        cells=new_cells,
        borderless=False,
    )


def _measure_merged_span(
    h_lines: list[HLine],
    v_lines: list[VLine],
    xs: list[float],
    ys: list[float],
    r: int,
    c: int,
    present: list[list[bool]],
    consumed: list[list[bool]],
) -> tuple[int, int]:
    """Determine how far an empty base region extends (merged cell)."""
    rows = len(present)
    cols = len(present[0]) if rows else 0
    # Walk right while no V border splits.
    cmax = c
    while cmax + 1 < cols and not _has_v_between(v_lines, xs[cmax + 1], ys[r], ys[r + 1]):
        cmax += 1
    # Walk down while no H border splits.
    rmax = r
    while rmax + 1 < rows and not _has_h_between(h_lines, ys[rmax + 1], xs[c], xs[cmax + 1]):
        rmax += 1
    # Must be bounded by outer borders.
    if not _has_h_between(h_lines, ys[r], xs[c], xs[cmax + 1]):
        return 0, 0
    if not _has_h_between(h_lines, ys[rmax + 1], xs[c], xs[cmax + 1]):
        return 0, 0
    if not _has_v_between(v_lines, xs[c], ys[r], ys[rmax + 1]):
        return 0, 0
    if not _has_v_between(v_lines, xs[cmax + 1], ys[r], ys[rmax + 1]):
        return 0, 0
    return rmax - r + 1, cmax - c + 1


def _dedup_floats(values: list[float], tol: float) -> list[float]:
    if not values:
        return []
    vs = sorted(values)
    out = [vs[0]]
    for v in vs[1:]:
        if v - out[-1] > tol:
            out.append(v)
    return out


# ---------- Borderless table inference ----------------------------------- #


def _infer_borderless_tables(
    h_lines: list[HLine],
    consumed_h: set[int],
    words: list[tuple[float, float, float, float, str]],
    page_w: float,
    page_h: float,
    starting_id: int,
    existing_tables: list[Table] | None = None,
) -> list[Table]:
    """Detect tables that have only horizontal rules (no vertical borders).

    Strategy: cluster H lines that share a similar x-range and are roughly
    evenly spaced. If two or more parallel H lines stack vertically (≥2
    gaps), treat the spanned region as a borderless table. Columns are
    inferred from vertically-aligned text runs above the topmost rule.
    """
    out: list[Table] = []

    def _inside_existing(h: HLine) -> bool:
        if not existing_tables:
            return False
        mid_x = (h.x0 + h.x1) / 2
        for t in existing_tables:
            if t.bbox.x - JOIN_TOL_PT <= mid_x <= t.bbox.x1 + JOIN_TOL_PT and \
               t.bbox.y - JOIN_TOL_PT <= h.y <= t.bbox.y1 + JOIN_TOL_PT:
                return True
        return False

    free_h = [
        (i, h) for i, h in enumerate(h_lines)
        if i not in consumed_h and not _inside_existing(h)
    ]
    if len(free_h) < 2:
        return out

    # Group H lines by x range similarity.
    free_h.sort(key=lambda p: p[1].y)
    used: set[int] = set()
    groups: list[list[tuple[int, HLine]]] = []
    for i, (idx, h) in enumerate(free_h):
        if idx in used:
            continue
        cluster: list[tuple[int, HLine]] = [(idx, h)]
        used.add(idx)
        for j in range(i + 1, len(free_h)):
            jdx, hj = free_h[j]
            if jdx in used:
                continue
            # Lines must share most of their x-extent.
            x0 = max(h.x0, hj.x0)
            x1 = min(h.x1, hj.x1)
            if x1 - x0 < min(h.x1 - h.x0, hj.x1 - hj.x0) * 0.7:
                continue
            # And lie within reasonable row-height range.
            if abs(hj.y - cluster[-1][1].y) > page_h * 0.25:
                continue
            cluster.append((jdx, hj))
            used.add(jdx)
        if len(cluster) >= 2:
            groups.append(cluster)

    table_id = starting_id
    for cluster in groups:
        cluster.sort(key=lambda p: p[1].y)
        ys = [p[1].y for p in cluster]
        # We need at least 2 row-gaps to call it a table.
        if len(ys) < 2:
            continue
        x_left = max(p[1].x0 for p in cluster)
        x_right = min(p[1].x1 for p in cluster)
        if x_right - x_left < page_w * 0.25:
            continue
        # Infer columns from text alignment in the table band.
        col_xs = _infer_columns_from_text(
            words, x_left, x_right, ys[0] - 12.0, ys[-1] + 12.0
        )
        col_xs = [x_left] + col_xs + [x_right]
        col_xs = _dedup_floats(col_xs, tol=8.0)
        if len(col_xs) < 2:
            col_xs = [x_left, x_right]
        cells: list[Cell] = []
        for r in range(len(ys) - 1):
            for c in range(len(col_xs) - 1):
                bx = col_xs[c]
                by = ys[r]
                bw = col_xs[c + 1] - bx
                bh = ys[r + 1] - by
                if bw < 16 or bh < 10:
                    continue
                cells.append(
                    Cell(
                        table_id=table_id,
                        row=r,
                        col=c,
                        row_span=1,
                        col_span=1,
                        bbox=Rect(x=bx, y=by, w=bw, h=bh),
                    )
                )
        if not cells:
            continue
        out.append(
            Table(
                id=table_id,
                bbox=Rect(x=x_left, y=ys[0], w=x_right - x_left, h=ys[-1] - ys[0]),
                row_bounds=ys,
                col_bounds=col_xs,
                cells=cells,
                borderless=True,
            )
        )
        table_id += 1
    return out


def _infer_columns_from_text(
    words: list[tuple[float, float, float, float, str]],
    x_left: float,
    x_right: float,
    y_top: float,
    y_bot: float,
) -> list[float]:
    """Approximate column splits from clusters of left-aligned text runs."""
    xs: list[float] = []
    for x0, y0, x1, y1, t in words:
        cy = (y0 + y1) / 2
        if not (y_top <= cy <= y_bot):
            continue
        if not (x_left <= x0 <= x_right):
            continue
        xs.append(x0)
    if not xs:
        return []
    xs.sort()
    # Cluster lefts within a small tolerance.
    clusters: list[list[float]] = [[xs[0]]]
    for x in xs[1:]:
        if x - clusters[-1][-1] <= 18.0:
            clusters[-1].append(x)
        else:
            clusters.append([x])
    # Require ≥ 2 supporting words per column (filters stray noise).
    candidates = [sum(c) / len(c) for c in clusters if len(c) >= 2]
    # Drop the first cluster (it's the left edge itself) and trim borders.
    return [x for x in candidates if x_left + 6 < x < x_right - 6]


# ---------- Standalone underlines / boxes / checkboxes ------------------- #


def _identify_standalone_underlines(
    h_lines: list[HLine],
    v_lines: list[VLine],
    consumed_h: set[int],
    page_w: float,
    words: list[tuple[float, float, float, float, str]] | None = None,
    tables: list[Table] | None = None,
) -> list[HLine]:
    """H lines that aren't part of any table → likely fill-line input fields.

    Filters out common false positives:
      * Lines covered by a V line at their midpoint (part of a small box).
      * Very short stray rules (<7% of page width).
      * Lines with text sitting ON them (decorative underlines for titles).
      * Lines whose midpoint falls inside a detected table bbox.
    """
    out: list[HLine] = []
    for i, h in enumerate(h_lines):
        if i in consumed_h:
            continue
        mid_x = (h.x0 + h.x1) / 2
        # Suppress lines that have a V cross at their middle (box pieces).
        if any(
            abs(v.x - mid_x) < (h.x1 - h.x0) * 0.25
            and v.y0 - JOIN_TOL_PT <= h.y <= v.y1 + JOIN_TOL_PT
            for v in v_lines
        ):
            continue
        if (h.x1 - h.x0) < max(page_w * 0.07, 36.0):
            continue
        # Suppress lines that overlap (vertically) with text — those are
        # decorative underlines under title text, not input rules.
        if words and _line_has_text_on_it(h, words):
            continue
        # Suppress lines that fall *strictly* inside a table's bbox —
        # using a small inset so that gap rows between adjacent tables
        # (where line.y sits on the seam) don't get suppressed.
        if tables and any(
            t.bbox.x + 1.0 <= mid_x <= t.bbox.x1 - 1.0
            and t.bbox.y + 1.0 <= h.y <= t.bbox.y1 - 1.0
            for t in tables
        ):
            continue
        out.append(h)
    return out


def _line_has_text_on_it(
    h: HLine,
    words: list[tuple[float, float, float, float, str]],
    y_tol: float = 6.0,
) -> bool:
    """True if a word visually sits on top of this H line.

    A word counts as "on the line" only when its x-CENTER falls inside
    the line's x range and the line's y position is within the word's
    y range (with a small slop). Using the x-center lets legitimate
    "Label: ____" patterns survive — there the label's right edge can
    touch the underline's left edge, which would otherwise look like an
    overlap.
    """
    if h.x1 <= h.x0:
        return False
    line_inset = 2.0
    for wx0, wy0, wx1, wy1, _t in words:
        cx = (wx0 + wx1) / 2
        if cx < h.x0 + line_inset or cx > h.x1 - line_inset:
            continue
        if wy0 - y_tol <= h.y <= wy1 + y_tol:
            return True
    return False


def _identify_standalone_boxes(
    h_lines: list[HLine],
    v_lines: list[VLine],
    consumed_h: set[int],
    consumed_v: set[int],
) -> list[Rect]:
    """Find 4-sided rectangles outside tables."""
    boxes: list[Rect] = []
    # Brute force is fine — line counts are modest.
    for hi, htop in enumerate(h_lines):
        if hi in consumed_h:
            continue
        for hj, hbot in enumerate(h_lines):
            if hj == hi or hj in consumed_h:
                continue
            if hbot.y - htop.y < 8.0:
                continue
            # x-overlap must cover both lines.
            x0 = max(htop.x0, hbot.x0)
            x1 = min(htop.x1, hbot.x1)
            if x1 - x0 < 16.0:
                continue
            # Find left + right V lines spanning [htop.y, hbot.y].
            left = None
            right = None
            for vi, v in enumerate(v_lines):
                if vi in consumed_v:
                    continue
                if not _vline_passes_segment(v, htop.y, hbot.y):
                    continue
                if abs(v.x - x0) <= JOIN_TOL_PT * 2:
                    left = v
                if abs(v.x - x1) <= JOIN_TOL_PT * 2:
                    right = v
            if left is None or right is None:
                continue
            boxes.append(Rect(x=left.x, y=htop.y, w=right.x - left.x, h=hbot.y - htop.y))
    return boxes


def _identify_checkbox_candidates(
    boxes: list[Rect],
    gray: np.ndarray | None,
    page_w: float,
    page_h: float,
    tables: list[Table],
    have_vector_lines: bool,
) -> list[Rect]:
    """Tiny near-square boxes that look like checkboxes.

    Image-based detection only runs as a fallback when no vector borders
    were found (scanned PDFs). It's strict on size and rejects anything
    overlapping a table region.
    """
    cands: list[Rect] = []
    for r in boxes:
        if r.w <= 0 or r.h <= 0:
            continue
        ar = r.w / r.h
        if 0.65 <= ar <= 1.4 and 6 <= r.w <= 22 and 6 <= r.h <= 22:
            cands.append(r)
    if have_vector_lines:
        return cands
    if gray is None or gray.size == 0:
        return cands
    ph, pw = gray.shape[:2]
    sx = page_w / max(1, pw)
    sy = page_h / max(1, ph)
    blur = cv2.GaussianBlur(gray, (3, 3), 0)
    _, bw = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(bw, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    for c in contours:
        x, y, cw, ch = cv2.boundingRect(c)
        # Strict size range in pixels (mapped to ~8-22pt at 2x render).
        if cw < 12 or ch < 12 or cw > 48 or ch > 48:
            continue
        ar = cw / float(ch) if ch else 0
        if not (0.8 <= ar <= 1.25):
            continue
        # Verify it's actually box-shaped (closed contour, ≈square).
        peri = cv2.arcLength(c, True)
        if peri <= 0:
            continue
        approx = cv2.approxPolyDP(c, 0.05 * peri, True)
        if len(approx) < 4 or len(approx) > 6:
            continue
        xp = x * sx
        yp = y * sy
        wp = cw * sx
        hp = ch * sy
        if _inside_any_table(xp + wp / 2, yp + hp / 2, tables):
            continue
        if any(abs(k.x - xp) < 3 and abs(k.y - yp) < 3 for k in cands):
            continue
        cands.append(Rect(x=xp, y=yp, w=wp, h=hp))
    return cands


def _inside_any_table(x: float, y: float, tables: list[Table]) -> bool:
    for t in tables:
        if t.bbox.x <= x <= t.bbox.x1 and t.bbox.y <= y <= t.bbox.y1:
            return True
    return False


# ---------- Public entry point ------------------------------------------- #


def extract_page_geometry(
    page: fitz.Page,
    gray: np.ndarray | None,
    page_w: float,
    page_h: float,
    page_num: int,
    words_override: list[tuple[float, float, float, float, str]] | None = None,
) -> PageGeometry:
    """Run Stage A on a single page. No semantics."""
    h_vec, v_vec = _vector_lines(page)
    if (len(h_vec) + len(v_vec)) < 4:
        h_ras, v_ras = _hough_lines_px_to_pt(gray, page_w, page_h) if gray is not None else ([], [])
        h_all = h_vec + h_ras
        v_all = v_vec + v_ras
    else:
        h_all = h_vec
        v_all = v_vec
    h_lines = _fuse_h_lines(h_all)
    v_lines = _fuse_v_lines(v_all)

    words = words_override if words_override is not None else _words(page)

    # Tables (proper bordered grids).
    clusters = _group_into_tables(h_lines, v_lines)
    tables: list[Table] = []
    consumed_h: set[int] = set()
    consumed_v: set[int] = set()
    h_index = {id(h): i for i, h in enumerate(h_lines)}
    v_index = {id(v): i for i, v in enumerate(v_lines)}
    next_table_id = 0
    for hs, vs in clusters:
        new_tables = _build_grids_from_cluster(hs, vs, next_table_id)
        if not new_tables:
            continue
        tables.extend(new_tables)
        next_table_id += len(new_tables)
        # Only mark as consumed the lines that actually form the borders
        # of one of the *final* sub-tables. Lines that fell in gap rows
        # between sub-tables remain available for standalone underline
        # detection.
        for t in new_tables:
            for h in hs:
                if any(abs(h.y - y) <= JOIN_TOL_PT for y in t.row_bounds):
                    mid_x = (h.x0 + h.x1) / 2
                    if (
                        t.bbox.x - JOIN_TOL_PT <= mid_x <= t.bbox.x1 + JOIN_TOL_PT
                    ):
                        consumed_h.add(h_index[id(h)])
            for v in vs:
                if any(abs(v.x - x) <= JOIN_TOL_PT for x in t.col_bounds):
                    mid_y = (v.y0 + v.y1) / 2
                    if (
                        t.bbox.y - JOIN_TOL_PT <= mid_y <= t.bbox.y1 + JOIN_TOL_PT
                    ):
                        consumed_v.add(v_index[id(v)])

    # Borderless tables (only horizontal rules). We pass already-detected
    # bordered tables so that interior decorative rules inside them are
    # not re-interpreted as a separate table.
    borderless = _infer_borderless_tables(
        h_lines, consumed_h, words, page_w, page_h,
        starting_id=next_table_id, existing_tables=tables,
    )
    for t in borderless:
        tables.append(t)
        # Borderless tables consume their H lines too.
        for h in h_lines:
            if any(abs(h.y - y) <= JOIN_TOL_PT for y in t.row_bounds):
                consumed_h.add(h_index[id(h)])

    standalone_underlines = _identify_standalone_underlines(
        h_lines, v_lines, consumed_h, page_w, words=words, tables=tables,
    )
    standalone_boxes = _identify_standalone_boxes(h_lines, v_lines, consumed_h, consumed_v)
    have_vector_lines = len(h_vec) + len(v_vec) >= 4
    checkboxes = _identify_checkbox_candidates(
        standalone_boxes, gray, page_w, page_h, tables, have_vector_lines
    )
    # Boxes that became checkbox candidates shouldn't also be standalone.
    cb_set = {(round(c.x, 1), round(c.y, 1)) for c in checkboxes}
    standalone_boxes = [
        b for b in standalone_boxes if (round(b.x, 1), round(b.y, 1)) not in cb_set
    ]

    return PageGeometry(
        page_num=page_num,
        page_w=page_w,
        page_h=page_h,
        h_lines=h_lines,
        v_lines=v_lines,
        tables=tables,
        standalone_underlines=standalone_underlines,
        standalone_boxes=standalone_boxes,
        checkbox_candidates=checkboxes,
        words=words,
    )


def page_geometry_to_debug(geom: PageGeometry) -> dict[str, Any]:
    """Serialise a PageGeometry for the /detect debug payload."""
    return {
        "page": geom.page_num,
        "tables": [
            {
                "id": t.id,
                "borderless": t.borderless,
                "bbox": {
                    "x": round(t.bbox.x, 2),
                    "y": round(t.bbox.y, 2),
                    "width": round(t.bbox.w, 2),
                    "height": round(t.bbox.h, 2),
                },
                "rowBounds": [round(y, 2) for y in t.row_bounds],
                "colBounds": [round(x, 2) for x in t.col_bounds],
                "cells": [
                    {
                        "row": c.row,
                        "col": c.col,
                        "rowSpan": c.row_span,
                        "colSpan": c.col_span,
                        "bbox": {
                            "x": round(c.bbox.x, 2),
                            "y": round(c.bbox.y, 2),
                            "width": round(c.bbox.w, 2),
                            "height": round(c.bbox.h, 2),
                        },
                    }
                    for c in t.cells
                ],
            }
            for t in geom.tables
        ],
        "standaloneUnderlines": [
            {"x0": round(h.x0, 2), "x1": round(h.x1, 2), "y": round(h.y, 2)}
            for h in geom.standalone_underlines
        ],
        "standaloneBoxes": [
            {"x": round(b.x, 2), "y": round(b.y, 2), "width": round(b.w, 2), "height": round(b.h, 2)}
            for b in geom.standalone_boxes
        ],
        "checkboxCandidates": [
            {"x": round(b.x, 2), "y": round(b.y, 2), "width": round(b.w, 2), "height": round(b.h, 2)}
            for b in geom.checkbox_candidates
        ],
    }
