"""Tests for the cell-first detection pipeline.

We construct synthetic PDFs (vector strokes + text) with PyMuPDF rather
than mocking the geometry layer — that way the tests exercise the whole
pipeline (Stage A through Stage D) end to end on representative shapes.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import fitz

from app import detector, fields, geometry


# ---------- Synthetic-PDF helpers --------------------------------------- #


def _new_page(width: float = 612.0, height: float = 792.0) -> tuple[fitz.Document, fitz.Page]:
    doc = fitz.open()
    page = doc.new_page(width=width, height=height)
    return doc, page


def _draw_rect(page: fitz.Page, x0: float, y0: float, x1: float, y1: float) -> None:
    """Draw a stroked rectangle (table border)."""
    page.draw_rect(fitz.Rect(x0, y0, x1, y1), color=(0, 0, 0), width=0.7)


def _draw_line(page: fitz.Page, x0: float, y0: float, x1: float, y1: float) -> None:
    page.draw_line(fitz.Point(x0, y0), fitz.Point(x1, y1), color=(0, 0, 0), width=0.7)


def _put_text(page: fitz.Page, x: float, y: float, text: str, fontsize: int = 11) -> None:
    page.insert_text(fitz.Point(x, y), text, fontsize=fontsize)


def _detect(doc: fitz.Document, **kwargs) -> dict:
    buf = doc.tobytes()
    return detector.detect_pdf(buf, max_pages=5, **kwargs)


# ---------- Cell-first contract ----------------------------------------- #


class CellFirstContractTests(unittest.TestCase):

    def test_blank_cell_with_multiple_interior_rules_emits_one_field(self) -> None:
        """The headline bug: a cell with N internal rules → exactly ONE input."""
        doc, page = _new_page()
        # Two-column table: label | value. Value cell contains 3 stray rules.
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 280, 100, 280, 160)  # column divider
        _put_text(page, 70, 135, "Batch Number")
        # Decorative interior rules inside the value cell.
        _draw_line(page, 290, 120, 530, 120)
        _draw_line(page, 290, 135, 530, 135)
        _draw_line(page, 290, 150, 530, 150)

        res = _detect(doc)
        sugs = [s for s in res["suggestions"] if s["fromCell"]]
        self.assertEqual(
            len(sugs), 1,
            f"Expected exactly one input cell, got {len(sugs)}: {sugs}",
        )
        s = sugs[0]
        # "Batch Number" names an alphanumeric identifier (a SKU-style
        # value), not a numeric quantity — classified as text.
        self.assertEqual(s["fieldType"], "text")
        self.assertIn("Batch Number", s["labelText"])

    def test_merged_cell_input_emits_one_wide_field(self) -> None:
        """A value spanning two grid columns produces one wide input, not two."""
        doc, page = _new_page()
        # 3-column header row, 1 merged cell on the data row.
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 220, 100, 220, 130)  # only in header row
        _draw_line(page, 380, 100, 380, 130)  # only in header row
        _draw_line(page, 60, 130, 540, 130)   # row separator
        _put_text(page, 70, 120, "Notes")

        res = _detect(doc)
        sugs = [s for s in res["suggestions"] if s["fromCell"]]
        # We expect at most one input in the merged data row.
        merged_inputs = [s for s in sugs if s["cellRow"] == 1]
        self.assertLessEqual(len(merged_inputs), 1)
        if merged_inputs:
            self.assertGreater(merged_inputs[0]["width"], 200)

    def test_label_cells_with_text_do_not_emit_inputs(self) -> None:
        doc, page = _new_page()
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 280, 100, 280, 160)
        # Both cells contain text → both treated as label/data, no inputs.
        _put_text(page, 70, 135, "Equipment")
        _put_text(page, 290, 135, "Mixer A")

        res = _detect(doc)
        from_cells = [s for s in res["suggestions"] if s["fromCell"]]
        self.assertEqual(from_cells, [])


# ---------- Label association ------------------------------------------- #


class LabelAssociationTests(unittest.TestCase):

    def test_two_col_label_value_inherits_left_label(self) -> None:
        doc, page = _new_page()
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 240, 100, 240, 160)
        _put_text(page, 70, 135, "Product Name")

        res = _detect(doc)
        sugs = [s for s in res["suggestions"] if s["fromCell"]]
        self.assertEqual(len(sugs), 1)
        self.assertIn("Product Name", sugs[0]["labelText"])

    def test_grid_table_uses_column_header_label_with_row_id_metadata(self) -> None:
        """Grid (≥3 cols): label = col header only, row id stored separately."""
        doc, page = _new_page()
        # 3 columns: Equipment | Initials | Date
        _draw_rect(page, 60, 100, 540, 200)
        _draw_line(page, 220, 100, 220, 200)
        _draw_line(page, 380, 100, 380, 200)
        _draw_line(page, 60, 130, 540, 130)  # below header
        _draw_line(page, 60, 165, 540, 165)  # second row separator
        _put_text(page, 70, 120, "Equipment")
        _put_text(page, 240, 120, "Initials")
        _put_text(page, 400, 120, "Date")
        _put_text(page, 70, 155, "Mixer A")

        res = _detect(doc)
        sugs = [s for s in res["suggestions"] if s["fromCell"]]
        # Inputs in row 1: cols 1 and 2 (col 0 has "Mixer A" text).
        row1 = [s for s in sugs if s["cellRow"] == 1]
        labels = [s["labelText"] for s in row1]
        # Disambiguation may suffix with the row id when labels collide
        # across rows in larger tables; here there's a single row so the
        # bare header still appears in the label string.
        self.assertTrue(any("Initials" in l for l in labels), f"got {labels}")
        self.assertTrue(any("Date" in l for l in labels), f"got {labels}")
        # Row id is retained as metadata for downstream grouping.
        row_ids = {s.get("rowId") for s in row1}
        self.assertEqual(row_ids, {"Mixer A"})

    def test_cell_text_handles_baseline_jitter_within_a_line(self) -> None:
        """Words on the same visual line can differ by ~1pt of baseline
        jitter (mixed glyphs with/without descenders). A bare
        round-to-3-pt bucket can put them in different buckets and
        scramble reading order, producing e.g. "°C) Storage Temperature
        (2-8" from "Storage Temperature (2-8 °C)".

        Greedy baseline clustering keeps them on the same line.
        """
        from app.geometry import Cell, Rect
        cell = Cell(table_id=0, row=0, col=0, row_span=1, col_span=1,
                    bbox=Rect(x=50.0, y=200.0, w=300.0, h=30.0))
        # 4 words at very close y tops; "°C)" sits ~1pt above the others
        # — exactly the jitter pattern observed on ARCT-2601 page 12.
        words = [
            (200.0, 207.5, 215.0, 219.5, "°C)"),
            (60.0, 208.4, 110.0, 219.4, "Storage"),
            (115.0, 208.4, 175.0, 219.4, "Temperature"),
            (180.0, 208.4, 198.0, 219.4, "(2-8"),
        ]
        text = fields._cell_text(cell, words)
        self.assertEqual(text, "Storage Temperature (2-8 °C)")

    def test_underscore_slot_in_grid_data_cell_uses_table_headers(self) -> None:
        """A cell whose only content is a unit suffix (`mg`) decorating an
        underscore slot should still pick up the table's row label and
        column header — not just the unit word.

        Mirrors the lipid weight-range layout on ARCT-2601 page 16:

            Lipids   | Target weight     | Lower limit       | Upper limit
            ATX-298  | ____ mg           | ____ mg           | ____ mg
            ATX-1057 | ____ mg           | ____ mg           | ____ mg

        Without grid-aware label association the cells emit nine
        identical "mg" fields disambiguated only by numeric suffix.
        """
        doc, page = _new_page()
        # 4-column header row + 2 data rows. Vertical dividers, horizontal
        # row separators.
        _draw_rect(page, 60, 100, 540, 200)
        for x in (170, 290, 410):
            _draw_line(page, x, 100, x, 200)
        _draw_line(page, 60, 130, 540, 130)  # below header
        _draw_line(page, 60, 165, 540, 165)  # below row 1
        # Header row
        _put_text(page, 80, 120, "Lipids")
        _put_text(page, 185, 120, "Target weight")
        _put_text(page, 305, 120, "Lower limit")
        _put_text(page, 425, 120, "Upper limit")
        # Row 1: row label + 3 unit-suffix value cells
        _put_text(page, 80, 155, "ATX-298")
        _put_text(page, 195, 155, "_______ mg")
        _put_text(page, 315, 155, "_______ mg")
        _put_text(page, 435, 155, "_______ mg")
        # Row 2: same shape, different lipid
        _put_text(page, 80, 190, "ATX-1057")
        _put_text(page, 195, 190, "_______ mg")
        _put_text(page, 315, 190, "_______ mg")
        _put_text(page, 435, 190, "_______ mg")

        res = _detect(doc)
        slot_fields = [
            s for s in res["suggestions"]
            if s.get("kind") == "underscore_input"
        ]
        labels = [s["labelText"] for s in slot_fields]
        # No field should be labelled bare "mg" / "mg #N" — the row+col
        # headers must be in the visible label.
        for l in labels:
            self.assertFalse(
                l.startswith("mg"),
                f"slot fell back to unit-suffix label: {l!r} (all: {labels})",
            )
        # Each composed label should carry both a column header and a
        # row identifier.
        for header in ("Target weight", "Lower limit", "Upper limit"):
            for row in ("ATX-298", "ATX-1057"):
                want = f"{header} — {row}"
                self.assertTrue(
                    any(want in l for l in labels),
                    f"missing {want!r} in {labels}",
                )


# ---------- Type classification ---------------------------------------- #


class TypeClassificationTests(unittest.TestCase):

    def setUp(self) -> None:
        detector._load_field_type_keywords.cache_clear()

    def test_numeric_label_classified_as_number(self) -> None:
        kw = detector._load_field_type_keywords()
        self.assertEqual(
            fields.classify_field_type("Actual Weight", kw), "number"
        )

    def test_date_label_classified_as_date(self) -> None:
        kw = detector._load_field_type_keywords()
        self.assertEqual(
            fields.classify_field_type("Manufacturing Date", kw), "date"
        )

    def test_signature_label_in_large_box(self) -> None:
        kw = detector._load_field_type_keywords()
        # large_box hint nudges sign-related labels toward signature.
        self.assertEqual(
            fields.classify_field_type(
                "Supervisor Approval", kw, geometry_hint="large_box"
            ),
            "signature",
        )

    def test_verified_by_is_text_not_checkbox(self) -> None:
        kw = detector._load_field_type_keywords()
        # "verified by" should be a text input (operator's name),
        # not a checkbox.
        self.assertEqual(fields.classify_field_type("Verified By", kw), "text")

    def test_tiny_square_forces_checkbox(self) -> None:
        kw = detector._load_field_type_keywords()
        self.assertEqual(
            fields.classify_field_type("Notes", kw, geometry_hint="tiny_square"),
            "checkbox",
        )

    def test_lot_number_classified_as_text_not_number(self) -> None:
        """Lot/Part/Batch/Serial/Catalog numbers are alphanumeric SKUs.

        The bare "number" / "no." / "id" keywords in the number bucket
        used to misclassify every such field. The text-identifier guard
        must beat the number keyword.
        """
        kw = detector._load_field_type_keywords()
        for label in (
            "Lot Number",
            "Part Number",
            "Batch Number",
            "Catalog Number",
            "Catalogue Number",
            "Serial Number",
            "Document No.",
            "PO Number",
            "Reference No",
            "Product Code",
        ):
            self.assertEqual(
                fields.classify_field_type(label, kw), "text",
                f"{label!r} should classify as text, not numeric",
            )

    def test_trailing_id_label_is_text(self) -> None:
        """Equipment-style IDs ("Balance ID", "Vessel ID") are alphanumeric."""
        kw = detector._load_field_type_keywords()
        for label in ("Balance ID", "Vessel ID", "Pump ID", "Equipment ID"):
            self.assertEqual(
                fields.classify_field_type(label, kw), "text",
                f"{label!r} should classify as text",
            )

    def test_number_label_still_classified_as_number(self) -> None:
        """The text-identifier guard must NOT swallow real numeric labels."""
        kw = detector._load_field_type_keywords()
        for label in (
            "Number of vials",
            "RNA concentration (mg/mL)",
            "Pressure (psi)",
            "Tare weight (g)",
        ):
            self.assertEqual(
                fields.classify_field_type(label, kw), "number",
                f"{label!r} should remain numeric",
            )

    def test_multi_word_date_time_label_classified_as_time(self) -> None:
        """Multi-word labels with HH:MM should be time, not text.

        Without the format-hint override, ``len(label.split()) >= 5``
        previously bumped these into the ambiguity fallback.
        """
        kw = detector._load_field_type_keywords()
        for label in (
            "Start Date and Time (HH:MM)",
            "End Date and Time (HH:MM)",
            "Additional thawing Start Date and time (DDMMYYYY, HH:MM)",
        ):
            self.assertEqual(
                fields.classify_field_type(label, kw), "time",
                f"{label!r} should classify as time",
            )

    def test_date_format_label_classified_as_date(self) -> None:
        """A pure DDMMYYYY-style format hint disambiguates to date."""
        kw = detector._load_field_type_keywords()
        self.assertEqual(
            fields.classify_field_type("Manufacture Date (DDMMYYYY)", kw),
            "date",
        )
        self.assertEqual(
            fields.classify_field_type("Expiry (DD/MM/YYYY)", kw),
            "date",
        )


# ---------- Coordinate hygiene ----------------------------------------- #


class CoordinateClampingTests(unittest.TestCase):

    def test_fields_lie_inside_page_rect(self) -> None:
        doc, page = _new_page(width=612.0, height=792.0)
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 240, 100, 240, 160)
        _put_text(page, 70, 135, "Product Name")

        res = _detect(doc)
        for s in res["suggestions"]:
            self.assertGreaterEqual(s["x"], 0)
            self.assertGreaterEqual(s["y"], 0)
            self.assertLessEqual(s["x"] + s["width"], 612.0 + 0.5)
            self.assertLessEqual(s["y"] + s["height"], 792.0 + 0.5)


# ---------- Borderless table inference --------------------------------- #


class BorderlessTableTests(unittest.TestCase):

    def test_borderless_table_with_horizontal_rules_only(self) -> None:
        """A 3-row band with H rules but no V borders. Columns inferred from text."""
        doc, page = _new_page()
        # H rules at y=140, 170, 200 (3 row band).
        _draw_line(page, 60, 140, 540, 140)
        _draw_line(page, 60, 170, 540, 170)
        _draw_line(page, 60, 200, 540, 200)
        # Vertically aligned text indicating columns at x=70 and x=300.
        _put_text(page, 70, 135, "Name")
        _put_text(page, 300, 135, "Initials")
        _put_text(page, 70, 165, "Alice")
        _put_text(page, 300, 165, "AB")

        res = _detect(doc, include_debug=True)
        # At least one borderless table should be recognised.
        borderless = [t for p in res["debug"]["pages"] for t in p["tables"] if t["borderless"]]
        self.assertGreaterEqual(len(borderless), 1)


# ---------- Fixture smoke test ----------------------------------------- #


class YesNoCheckboxTests(unittest.TestCase):

    def test_yes_no_value_cell_emits_checkbox_labelled_by_row(self) -> None:
        doc, page = _new_page()
        _draw_rect(page, 60, 100, 540, 160)
        _draw_line(page, 240, 100, 240, 160)  # 2-col layout
        _put_text(page, 70, 135, "Approved:")
        _put_text(page, 260, 135, "I Yes I No")

        res = _detect(doc)
        sugs = [s for s in res["suggestions"] if s["fromCell"]]
        # Should emit a single checkbox-typed field for the value cell.
        self.assertEqual(len(sugs), 1)
        s = sugs[0]
        self.assertEqual(s["fieldType"], "checkbox")
        self.assertIn("Approved", s["labelText"])

    def test_wrapped_question_with_trailing_yes_no_is_checkbox(self) -> None:
        """A real-world cell can wrap a question across multiple lines
        and end with the Yes/No prompt. The previous 4-word cap
        rejected such cells; we now accept them when they contain a
        literal "?" and the binary pair sits in the trailing portion.
        """
        self.assertTrue(fields._is_checkbox_prompt(
            "Storage time at 2-8 °C < 48 hours? Yes / No"
        ))
        self.assertTrue(fields._is_checkbox_prompt(
            "Is mRNA solution completely thawed? "
            "If yes, keep at 2-8ºC until use. "
            "If no, store at ambient temperature (18-25ºC). Yes / No"
        ))
        # Long descriptive paragraph that incidentally mentions yes/no
        # in its body — still NOT a checkbox prompt.
        self.assertFalse(fields._is_checkbox_prompt(
            "Yes the operator confirms that the procedure was followed. "
            "No abnormalities were observed during the manufacturing run "
            "and no deviations were reported by the supervisor."
        ))

    def test_normal_yes_in_long_sentence_is_not_checkbox_prompt(self) -> None:
        from app import fields as F
        self.assertFalse(F._is_checkbox_prompt("Yes the operator confirmed the lot"))
        self.assertTrue(F._is_checkbox_prompt("Yes / No"))
        self.assertTrue(F._is_checkbox_prompt("I Yes I No"))
        self.assertTrue(F._is_checkbox_prompt("Pass / Fail"))


class HeaderCarryTests(unittest.TestCase):

    def _two_page_log(self) -> fitz.Document:
        # Page 1: header table with 3 cols, no data rows.
        doc = fitz.open()
        p1 = doc.new_page(width=612, height=792)
        _draw_rect(p1, 60, 100, 540, 130)
        _draw_line(p1, 220, 100, 220, 130)
        _draw_line(p1, 380, 100, 380, 130)
        _put_text(p1, 70, 120, "Time")
        _put_text(p1, 240, 120, "Temperature")
        _put_text(p1, 400, 120, "Operator")
        # Page 2: continuation with same column boundaries, 3 empty rows.
        p2 = doc.new_page(width=612, height=792)
        _draw_rect(p2, 60, 50, 540, 140)
        _draw_line(p2, 220, 50, 220, 140)
        _draw_line(p2, 380, 50, 380, 140)
        _draw_line(p2, 60, 80, 540, 80)
        _draw_line(p2, 60, 110, 540, 110)
        return doc

    def test_continuation_table_inherits_headers_from_previous_page(self) -> None:
        doc = self._two_page_log()
        res = _detect(doc)
        page2 = [s for s in res["suggestions"] if s["page"] == 2 and s["fromCell"]]
        labels = [s["labelText"] for s in page2]
        # Page 2 inherits Time/Temperature/Operator. With three empty
        # rows the labels collide, so disambiguation appends "#1/#2/#3".
        # We only need each header to *appear* in at least one label.
        for header in ("Time", "Temperature", "Operator"):
            self.assertTrue(
                any(header in l for l in labels),
                f"Expected inherited header {header!r}, got {labels}",
            )


class InformationalTableTests(unittest.TestCase):
    """Tables of contents / reference blocks shouldn't emit any inputs."""

    def test_table_of_contents_emits_no_fields(self) -> None:
        doc, page = _new_page()
        # 2-col, 4-row TOC: each cell already holds text.
        _draw_rect(page, 60, 100, 540, 260)
        _draw_line(page, 460, 100, 460, 260)
        _draw_line(page, 60, 140, 540, 140)
        _draw_line(page, 60, 180, 540, 180)
        _draw_line(page, 60, 220, 540, 220)
        _put_text(page, 70, 130, "1. Introduction")
        _put_text(page, 470, 130, "3")
        _put_text(page, 70, 170, "2. Methods")
        _put_text(page, 470, 170, "5")
        _put_text(page, 70, 210, "3. Results")
        _put_text(page, 470, 210, "8")
        _put_text(page, 70, 250, "4. Discussion")
        _put_text(page, 470, 250, "12")

        res = _detect(doc)
        from_cells = [s for s in res["suggestions"] if s["fromCell"]]
        self.assertEqual(
            from_cells, [],
            "A fully-filled TOC table should produce no input fields",
        )

    def test_form_table_with_empty_value_cells_still_emits(self) -> None:
        """Regression: a normal 'label → empty input' form must keep emitting."""
        doc, page = _new_page()
        # 2-col, 3-row form: left column has labels, right column empty.
        _draw_rect(page, 60, 100, 540, 220)
        _draw_line(page, 240, 100, 240, 220)
        _draw_line(page, 60, 140, 540, 140)
        _draw_line(page, 60, 180, 540, 180)
        _put_text(page, 70, 130, "Product Name")
        _put_text(page, 70, 170, "Lot Number")
        _put_text(page, 70, 210, "Manufacture Date")

        res = _detect(doc)
        from_cells = [s for s in res["suggestions"] if s["fromCell"]]
        self.assertEqual(
            len(from_cells), 3,
            f"Expected three input cells, got {len(from_cells)}: {from_cells}",
        )

    def test_informational_helper_detects_static_grid(self) -> None:
        """Unit-level check on the helper, decoupled from PDF rendering."""
        from app import fields as F
        from app.geometry import Cell, Rect, Table

        # 3x3 grid, every cell filled — references-style block.
        cells = []
        row_bounds = [0.0, 20.0, 40.0, 60.0]
        col_bounds = [0.0, 40.0, 80.0, 120.0]
        for r in range(3):
            for c in range(3):
                cells.append(Cell(
                    table_id=1, row=r, col=c, row_span=1, col_span=1,
                    bbox=Rect(x=col_bounds[c], y=row_bounds[r], w=40.0, h=20.0),
                ))
        table = Table(
            id=1,
            bbox=Rect(x=0.0, y=0.0, w=120.0, h=60.0),
            row_bounds=row_bounds,
            col_bounds=col_bounds,
            cells=cells,
        )
        cell_texts = {
            (r, c): f"Item {r}.{c}" for r in range(3) for c in range(3)
        }
        # _cell_role consults the words list to verify there's real
        # content in the cell — synthesise a word per cell.
        words = []
        for r in range(3):
            for c in range(3):
                cx = col_bounds[c] + 5.0
                cy = row_bounds[r] + 10.0
                words.append((cx, cy, cx + 30.0, cy + 8.0, f"Item{r}{c}"))
        self.assertTrue(F._is_informational_table(table, cell_texts, words))

    def test_informational_helper_rejects_form_with_input_slots(self) -> None:
        from app import fields as F
        from app.geometry import Cell, Rect, Table

        # Left column filled, right column empty — classic 2-col form.
        cells = []
        row_bounds = [0.0, 20.0, 40.0, 60.0]
        col_bounds = [0.0, 60.0, 120.0]
        for r in range(3):
            for c in range(2):
                cells.append(Cell(
                    table_id=2, row=r, col=c, row_span=1, col_span=1,
                    bbox=Rect(x=col_bounds[c], y=row_bounds[r], w=60.0, h=20.0),
                ))
        table = Table(
            id=2,
            bbox=Rect(x=0.0, y=0.0, w=120.0, h=60.0),
            row_bounds=row_bounds,
            col_bounds=col_bounds,
            cells=cells,
        )
        cell_texts = {
            (0, 0): "Product Name", (0, 1): "",
            (1, 0): "Lot Number",   (1, 1): "",
            (2, 0): "Date",         (2, 1): "",
        }
        # Left-column words only — right column is intentionally empty.
        words = []
        for r, label in enumerate(("Product Name", "Lot Number", "Date")):
            cx = col_bounds[0] + 5.0
            cy = row_bounds[r] + 10.0
            words.append((cx, cy, cx + 40.0, cy + 8.0, label))
        self.assertFalse(F._is_informational_table(table, cell_texts, words))


class BorderedTextBlockTests(unittest.TestCase):
    """Bordered text blocks (headings, callouts) shouldn't emit fields."""

    def _make_words(self, items):
        """items: iterable of (x, y, w, h, text). Returns words tuples."""
        return [(x, y, x + w, y + h, t) for (x, y, w, h, t) in items]

    def test_empty_box_is_input_area(self) -> None:
        from app import fields as F
        from app.geometry import Rect
        box = Rect(x=100.0, y=100.0, w=200.0, h=40.0)
        self.assertTrue(F._box_has_input_area(box, []))

    def test_bordered_heading_is_not_input_area(self) -> None:
        from app import fields as F
        from app.geometry import Rect
        box = Rect(x=100.0, y=100.0, w=200.0, h=40.0)
        # A heading "EXECUTIVE SUMMARY" filling the bordered region.
        words = self._make_words([
            (115.0, 110.0, 70.0, 12.0, "EXECUTIVE"),
            (190.0, 110.0, 90.0, 12.0, "SUMMARY"),
        ])
        self.assertFalse(F._box_has_input_area(box, words))

    def test_label_colon_with_empty_trail_is_input_area(self) -> None:
        from app import fields as F
        from app.geometry import Rect
        box = Rect(x=100.0, y=100.0, w=300.0, h=40.0)
        # "Name:" sits on the left; the rest of the box is empty space.
        words = self._make_words([
            (105.0, 115.0, 40.0, 12.0, "Name:"),
        ])
        self.assertTrue(F._box_has_input_area(box, words))

    def test_bordered_paragraph_is_not_input_area(self) -> None:
        from app import fields as F
        from app.geometry import Rect
        box = Rect(x=100.0, y=100.0, w=300.0, h=60.0)
        # Two-line paragraph that spans most of each baseline.
        words = self._make_words([
            (105.0, 110.0, 80.0, 10.0, "Quality"),
            (190.0, 110.0, 60.0, 10.0, "control"),
            (255.0, 110.0, 90.0, 10.0, "review"),
            (350.0, 110.0, 40.0, 10.0, "data"),
            (105.0, 130.0, 70.0, 10.0, "must"),
            (180.0, 130.0, 30.0, 10.0, "be"),
            (215.0, 130.0, 90.0, 10.0, "validated"),
            (310.0, 130.0, 80.0, 10.0, "monthly"),
        ])
        self.assertFalse(F._box_has_input_area(box, words))


class CheckboxPromptHeuristicTests(unittest.TestCase):

    def test_version_no_not_checkbox(self) -> None:
        from app import fields as F
        # "Version No: 0.1" contains "No" but is a label+value, not a
        # binary prompt — must not be treated as a checkbox.
        self.assertFalse(F._is_checkbox_prompt("Version No: 0.1"))
        self.assertFalse(F._is_checkbox_prompt("No. of Items"))

    def test_standalone_yes_or_no_still_checkbox(self) -> None:
        from app import fields as F
        self.assertTrue(F._is_checkbox_prompt("Yes"))
        self.assertTrue(F._is_checkbox_prompt("No"))

    def test_binary_pairs_still_checkbox(self) -> None:
        from app import fields as F
        self.assertTrue(F._is_checkbox_prompt("Yes / No"))
        self.assertTrue(F._is_checkbox_prompt("I Yes I No"))
        self.assertTrue(F._is_checkbox_prompt("Pass / Fail"))


class TestBatchRecordFixtureTests(unittest.TestCase):
    """Pinned behaviour for data/imgs/TestBatchRecord.pdf page 1.

    The page contains a header table (filled cells), a bordered BATCH
    RECORD heading, a paragraph block, and four signature rows. The only
    fields we should emit are the four "Print Name / Signature" and the
    four "Date" underlines.
    """

    @classmethod
    def _detect_first_page(cls):
        from app import detector
        fixture = (
            Path(__file__).resolve().parents[2]
            / "data" / "imgs" / "TestBatchRecord.pdf"
        )
        cls.assertTrue_path = fixture.exists()
        return detector.detect_pdf(fixture.read_bytes(), max_pages=1)

    def test_emits_only_signature_and_date_underlines(self) -> None:
        res = self._detect_first_page()
        kinds = [s["kind"] for s in res["suggestions"]]
        self.assertEqual(
            set(kinds), {"standalone_underline"},
            f"Unexpected non-underline fields emitted: {kinds}",
        )
        labels = sorted(s["labelText"].lower() for s in res["suggestions"])
        prepared = [l for l in labels if l.startswith("prepared")]
        # Disambiguation suffixes duplicates with "#N", so accept any
        # label that starts with the bare "date" word.
        dates = [l for l in labels if l == "date" or l.startswith("date ")]
        self.assertEqual(len(prepared), 4, f"expected 4 Prepared-By underlines, got {prepared}")
        self.assertEqual(len(dates), 4, f"expected 4 Date underlines, got {dates}")
        self.assertEqual(len(res["suggestions"]), 8)

    def test_no_field_over_filled_header_cells(self) -> None:
        res = self._detect_first_page()
        # Top header table sits between y=36 and y=83.
        for s in res["suggestions"]:
            self.assertFalse(
                s["y"] < 90,
                f"Spurious field on top header table: {s}",
            )

    def test_no_field_over_bordered_paragraph_block(self) -> None:
        res = self._detect_first_page()
        # Body box sits between y≈120 and y≈230 for the heading +
        # paragraph rows. No field should land in that band.
        for s in res["suggestions"]:
            cy = s["y"] + s["height"] / 2
            self.assertFalse(
                120 < cy < 230,
                f"Spurious field inside paragraph block: {s}",
            )


class StackedNestedSubGridTests(unittest.TestCase):
    """A merged step-Instructions cell can host multiple sub-tables
    stacked vertically. The bottom sub-table often shares its bottom
    border with the parent cell — and its V-lines span only a small
    fraction of the parent's height — so the previous "single sub-grid
    per merged cell" path missed it entirely.

    Concrete real-world example: COVID-2LYO p35/p36 step 11.5.2 where
    a 4-column Tare weight / Gross weight / Net Weight / Meets
    Criterion? grid sits flush at the bottom of the Instructions cell.
    """

    def test_two_stacked_sub_grids_in_one_merged_cell(self) -> None:
        doc, page = _new_page(width=612.0, height=792.0)
        # Outer Step|Instructions|Signature: 3 cols, 3 rows.
        # Step | Instructions (merged 1-row, but a tall cell) | Signature
        out_y0 = 100.0
        out_y1 = 460.0
        _draw_rect(page, 60, out_y0, 540, out_y1)
        _draw_line(page, 120, out_y0, 120, out_y1)  # Step | Instructions
        _draw_line(page, 470, out_y0, 470, out_y1)  # Instructions | Signature
        _draw_line(page, 60, 130, 540, 130)  # below outer header row
        _put_text(page, 70, 120, "Step")
        _put_text(page, 250, 120, "Instructions")
        _put_text(page, 480, 120, "Signature")

        # First inner sub-grid: 2-col "Target weight | Balance ID"
        # placed near the top of the merged Instructions cell.
        sub1_y0, sub1_y1 = 160.0, 240.0
        _draw_line(page, 140, sub1_y0, 140, sub1_y1)  # left
        _draw_line(page, 260, sub1_y0, 260, sub1_y1)  # divider
        _draw_line(page, 440, sub1_y0, 440, sub1_y1)  # right
        _draw_line(page, 140, sub1_y0, 440, sub1_y0)  # top
        _draw_line(page, 140, 200, 440, 200)  # mid
        _draw_line(page, 140, sub1_y1, 440, sub1_y1)  # bottom
        _put_text(page, 150, sub1_y0 + 20, "Target weight")
        _put_text(page, 270, sub1_y0 + 20, "Balance ID")

        # Second inner sub-grid: 4-col Tare / Gross / Net / Meets at the
        # very bottom — its BOTTOM RULE IS THE PARENT'S BOTTOM border
        # (no explicit H line drawn at sub2_y1).
        sub2_y0 = 380.0
        sub2_y1 = out_y1  # ← shared with parent's bottom border
        for x in (140, 220, 300, 380, 440):
            _draw_line(page, x, sub2_y0, x, sub2_y1)
        _draw_line(page, 140, sub2_y0, 440, sub2_y0)  # top
        _draw_line(page, 140, 420, 440, 420)  # mid (between header and data row)
        _put_text(page, 150, sub2_y0 + 20, "Tare weight")
        _put_text(page, 230, sub2_y0 + 20, "Gross weight")
        _put_text(page, 310, sub2_y0 + 20, "Net Weight")
        _put_text(page, 390, sub2_y0 + 20, "Meets?")

        res = _detect(doc)
        labels = [s["labelText"] for s in res["suggestions"]]
        # Both sub-grid columns must produce a field.
        for want in ("Target weight", "Balance ID", "Tare weight",
                     "Gross weight", "Net Weight", "Meets?"):
            self.assertTrue(
                any(want in l for l in labels),
                f"missing column {want!r} in {labels}",
            )


class TallEmptyColumnSplitTests(unittest.TestCase):
    """A tall, empty merged cell that spans many rows of other columns
    must be virtually split so each donor row gets its own field.

    Mirrors the rightmost "Recorded By/Date" column of the Equipment
    table on ARCT-2601 page 10, which is rendered as a single tall cell
    while the other columns have one cell per equipment item.
    """

    def test_tall_empty_right_column_splits_per_row(self) -> None:
        doc, page = _new_page()
        # Outer table: 5 cols, 5 rows. Right column has NO horizontal
        # rules through it — it's one tall merged cell.
        x0, x1 = 60.0, 540.0
        y0 = 100.0
        row_h = 30.0
        n_rows = 5  # 1 header + 4 data rows
        # Top + bottom borders only on the right column edge.
        _draw_rect(page, x0, y0, x1, y0 + row_h * n_rows)
        # Vertical column dividers — last divider is at x = 470 so the
        # rightmost column spans x=470..540.
        for x in (140.0, 240.0, 340.0, 470.0):
            _draw_line(page, x, y0, x, y0 + row_h * n_rows)
        # Horizontal row separators — only between cols 0..3 (stop at
        # x=470 so the right column stays merged).
        for r in range(1, n_rows):
            _draw_line(page, x0, y0 + r * row_h, 470.0, y0 + r * row_h)
        # Header
        _put_text(page, 70, y0 + 18, "Equipment")
        _put_text(page, 150, y0 + 18, "Source")
        _put_text(page, 250, y0 + 18, "Serial")
        _put_text(page, 350, y0 + 18, "Calibration")
        _put_text(page, 480, y0 + 18, "Recorded By")
        # Row labels in col 0
        for i, name in enumerate(("Mixer A", "Mixer B", "Pump X", "Pump Y"), start=1):
            _put_text(page, 70, y0 + i * row_h + 18, name)

        res = _detect(doc)
        rec = [s for s in res["suggestions"] if "Recorded By" in s["labelText"]]
        # Should produce one field per equipment row (4) — not just 1.
        self.assertEqual(
            len(rec), 4,
            f"expected one Recorded By field per row, got {len(rec)}: "
            f"{[s['labelText'] for s in rec]}",
        )
        labels = {s["labelText"] for s in rec}
        for name in ("Mixer A", "Mixer B", "Pump X", "Pump Y"):
            self.assertTrue(
                any(name in l for l in labels),
                f"row id {name!r} missing from Recorded By fields: {labels}",
            )


class RepeatingRowDetectionTests(unittest.TestCase):
    """A homogeneous data-log table (anonymous empty rows under one
    header — e.g., a UFDF pressure log) should be tagged `repeating`
    so the frontend can collapse it into one "+ Add row" widget.

    Tables where every row carries a distinct row identifier (BoM,
    Equipment) must NOT be tagged.
    """

    def _make_table(self, headers: list[str], data_rows: list[list[str]]):
        doc, page = _new_page(width=612.0, height=792.0)
        n_cols = len(headers)
        n_rows = 1 + len(data_rows)
        x0, x1 = 60.0, 540.0
        y0 = 100.0
        row_h = 30.0
        _draw_rect(page, x0, y0, x1, y0 + row_h * n_rows)
        # Column dividers
        col_w = (x1 - x0) / n_cols
        for c in range(1, n_cols):
            _draw_line(page, x0 + c * col_w, y0, x0 + c * col_w, y0 + row_h * n_rows)
        # Row dividers
        for r in range(1, n_rows):
            _draw_line(page, x0, y0 + r * row_h, x1, y0 + r * row_h)
        # Header text
        for c, h in enumerate(headers):
            _put_text(page, x0 + c * col_w + 5, y0 + 18, h)
        # Data text
        for r, row in enumerate(data_rows):
            for c, txt in enumerate(row):
                if txt:
                    _put_text(page, x0 + c * col_w + 5, y0 + (r + 1) * row_h + 18, txt)
        return doc

    def test_anonymous_log_rows_are_tagged_repeating(self) -> None:
        # 3 columns of empty data rows under a header → repeating.
        doc = self._make_table(
            headers=["Time (min)", "Pressure (psi)", "Flow (mL/min)"],
            data_rows=[["", "", ""] for _ in range(5)],
        )
        res = _detect(doc)
        cell_sugs = [s for s in res["suggestions"] if s.get("fromCell")]
        self.assertGreater(len(cell_sugs), 0)
        # Every cell field should be flagged repeating with a shared id.
        groups = {s.get("repeatGroupId") for s in cell_sugs if s.get("repeating")}
        self.assertEqual(
            len([s for s in cell_sugs if s.get("repeating")]),
            len(cell_sugs),
            f"expected all {len(cell_sugs)} cell fields tagged, got "
            f"{sum(1 for s in cell_sugs if s.get('repeating'))}: {cell_sugs}",
        )
        self.assertEqual(len(groups - {None}), 1, f"expected 1 group, got {groups}")
        rows_observed = {s.get("repeatRowsObserved") for s in cell_sugs if s.get("repeating")}
        self.assertEqual(rows_observed, {5})

    def test_labeled_rows_are_not_tagged(self) -> None:
        # BoM-style: each data row has a distinct row label in col 0.
        doc = self._make_table(
            headers=["Material", "Vendor", "Lot Number"],
            data_rows=[
                ["Material A", "", ""],
                ["Material B", "", ""],
                ["Material C", "", ""],
                ["Material D", "", ""],
            ],
        )
        res = _detect(doc)
        tagged = [s for s in res["suggestions"] if s.get("repeating")]
        self.assertEqual(
            tagged, [],
            f"BoM-style table with distinct row ids should not be "
            f"tagged repeating: {tagged}",
        )


class TestBatchRecord2BomTests(unittest.TestCase):
    """Pinned behaviour for the Bill of Materials table on page 1 of
    TestBatchRecord2.pdf. The table has 6 columns (Materials, Vendor,
    Part Number, Lot Number, Expiration Date, Recorded By/Date), a
    rightmost merged-down column, and inset double-border styling on
    every cell."""

    @classmethod
    def _detect_first_page(cls):
        from app import detector
        fixture = (
            Path(__file__).resolve().parents[2]
            / "data" / "imgs" / "TestBatchRecord2.pdf"
        )
        return detector.detect_pdf(fixture.read_bytes(), max_pages=1, include_debug=True)

    def test_bom_table_is_six_columns(self) -> None:
        res = self._detect_first_page()
        tables = res["debug"]["pages"][0]["tables"]
        bom = next(
            (t for t in tables if 100 < t["bbox"]["y"] < 200 and t["bbox"]["height"] > 200),
            None,
        )
        self.assertIsNotNone(bom, "BoM table not found")
        cols = len(bom["colBounds"]) - 1
        rows = len(bom["rowBounds"]) - 1
        self.assertEqual(cols, 6, f"Expected 6 columns, got {cols}")
        self.assertGreaterEqual(rows, 13, f"Expected ≥13 rows, got {rows}")

    def test_bom_column_types_follow_header(self) -> None:
        res = self._detect_first_page()
        bom_fields = [
            s for s in res["suggestions"]
            if s.get("fromCell") and s.get("tableId") is not None
            and 130 < s["y"] < 460
        ]
        # Every emitted field's type should match its column header. After
        # disambiguation the label is "<Header> — <row id>", so match on
        # the column header substring.
        expected = {
            "Vendor": "text",
            # "Lot Number" / "Part Number" name alphanumeric identifiers,
            # not numeric quantities — text, not number.
            "Part Number": "text",
            "Lot Number": "text",
            "Expiration Date": "date",
            "Recorded By/Date": "date",  # may also be text — date acceptable
        }
        for s in bom_fields:
            want = None
            for header, ftype in expected.items():
                if s["labelText"].startswith(header):
                    want = ftype
                    break
            if want is None:
                continue
            self.assertEqual(
                s["fieldType"], want,
                f"Column '{s['labelText']}' should emit type '{want}', got '{s['fieldType']}'",
            )

    def test_bom_skips_na_cells(self) -> None:
        res = self._detect_first_page()
        # No emitted field should carry the literal label "N/A".
        for s in res["suggestions"]:
            self.assertNotEqual(
                s["labelText"], "N/A",
                f"N/A cell should not produce a field: {s}",
            )

    def test_bom_no_standalone_boxes_inside_table(self) -> None:
        res = self._detect_first_page()
        # The inset frames inside cells must not leak as standalone boxes.
        boxes = [s for s in res["suggestions"] if s["kind"] == "standalone_box"]
        in_bom = [s for s in boxes if 130 < s["y"] < 460 and 40 < s["x"] < 570]
        self.assertEqual(in_bom, [], f"Standalone boxes inside BoM: {in_bom}")


class TestBatchRecord3UnderscoreInputsTests(unittest.TestCase):
    """Pinned behaviour for the RNA Calculations step table on page 1 of
    TestBatchRecord3.pdf. Each fill-in slot is drawn with underscore
    characters (`_______`, `______mg`, `=____g`); the caption sits below
    each blank, except for the signature column where it sits above.
    """

    @classmethod
    def _detect_first_page(cls):
        from app import detector
        fixture = (
            Path(__file__).resolve().parents[2]
            / "data" / "imgs" / "TestBatchRecord3.pdf"
        )
        return detector.detect_pdf(fixture.read_bytes(), max_pages=1)

    def test_emits_underscore_fields(self) -> None:
        res = self._detect_first_page()
        u_fields = [s for s in res["suggestions"] if s["kind"] == "underscore_input"]
        self.assertGreaterEqual(
            len(u_fields), 19,
            f"Expected ≥19 underscore inputs, got {len(u_fields)}",
        )

    def test_signature_lines_alternate_performed_reviewed(self) -> None:
        res = self._detect_first_page()
        sig_fields = [
            s for s in res["suggestions"]
            if s["kind"] == "underscore_input" and s["x"] > 500
        ]
        labels = [s["labelText"] for s in sig_fields]
        # Disambiguation appends "#N" to duplicates; the base header must
        # still appear in at least one label.
        self.assertTrue(
            any("Performed by/Date" in l for l in labels),
            f"got {labels}",
        )
        self.assertTrue(
            any("Reviewed by/Date" in l for l in labels),
            f"got {labels}",
        )

    def test_units_trigger_number_field_type(self) -> None:
        res = self._detect_first_page()
        # Any underscore_input whose CAPTION mentions "mass", "weight",
        # "volume" or "concentration" should be a number field — those
        # captions accompany unit-suffix slots in this fixture. We test
        # the caption only (the label segment before " — "), since
        # step-aware disambiguation may append the surrounding step text
        # to the display label and that step text can incidentally
        # contain those tokens for non-numeric fields like
        # "Performed by/Date".
        for s in res["suggestions"]:
            if s["kind"] != "underscore_input":
                continue
            caption = s["labelText"].split(" — ", 1)[0].lower()
            if any(k in caption for k in ("mass", "weight", "volume", "concentration")):
                self.assertEqual(
                    s["fieldType"], "number",
                    f"Numeric quantity should be number type: {s}",
                )

    def test_step_caption_not_truncated_at_column_edge(self) -> None:
        res = self._detect_first_page()
        labels = [s["labelText"] for s in res["suggestions"]]
        # A wrapped multi-line caption must come through fully.
        self.assertTrue(
            any("Target mass of RNA with overage from step 9.2.1" in l for l in labels),
            f"Expected wrapped caption to be captured fully, got {labels}",
        )


class TestBatchRecord4NestedTableTests(unittest.TestCase):
    """Page 1 of TestBatchRecord4.pdf nests a label/value sub-table inside
    Step 9.1.1's Instructions cell. The outer table merges that whole
    region; we need to recover the inner grid and emit one field per
    empty value cell. The Step column should emit no fields at all."""

    @classmethod
    def _detect_first_page(cls):
        from app import detector
        fixture = (
            Path(__file__).resolve().parents[2]
            / "data" / "imgs" / "TestBatchRecord4.pdf"
        )
        return detector.detect_pdf(fixture.read_bytes(), max_pages=1)

    def test_step_column_emits_no_fields(self) -> None:
        res = self._detect_first_page()
        for s in res["suggestions"]:
            # Step column is the narrow x=43–85 band.
            self.assertFalse(
                s["x"] < 85 and s["width"] < 60,
                f"Spurious field in Step column: {s}",
            )
            self.assertNotEqual(
                s["labelText"], "Step",
                f"A field labelled just 'Step' should never be emitted: {s}",
            )

    def test_nested_inner_table_emits_inputs(self) -> None:
        res = self._detect_first_page()
        nested = [s for s in res["suggestions"] if s["kind"].startswith("nested_cell")]
        # Step 9.1.1 has ~12 inner rows; we expect at least 10 nested
        # fields covering the empty value cells and Yes/No prompts.
        self.assertGreaterEqual(
            len(nested), 10,
            f"Expected ≥10 nested inputs, got {len(nested)}: "
            f"{[s['labelText'] for s in nested]}",
        )

    def test_nested_labels_capture_expected_rows(self) -> None:
        res = self._detect_first_page()
        labels = {s["labelText"] for s in res["suggestions"]}
        for needle in (
            "mRNA-1801-2 Lot Number",
            "Storage Location",
            "RNA concentration (mg/mL)",
        ):
            matched = any(needle in l for l in labels)
            self.assertTrue(matched, f"Expected a field labelled containing {needle!r}, got {labels}")

    def test_cell_text_orders_words_top_to_bottom(self) -> None:
        from app import fields as F
        from app.geometry import Cell, Rect
        cell = Cell(
            table_id=0, row=0, col=0, row_span=1, col_span=1,
            bbox=Rect(x=0.0, y=0.0, w=200.0, h=60.0),
        )
        # Words deliberately given in non-reading order.
        words = [
            (10.0, 40.0, 50.0, 52.0, "additional"),
            (5.0, 10.0, 30.0, 22.0, "Is"),
            (40.0, 10.0, 100.0, 22.0, "complete?"),
            (5.0, 25.0, 100.0, 37.0, "Multi-line cell"),
        ]
        text = F._cell_text(cell, words)
        self.assertEqual(text, "Is complete? Multi-line cell additional")


class FixtureSmokeTests(unittest.TestCase):

    def test_example_pdf_emits_only_cell_inputs_for_table_fields(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2] / "data" / "imgs" / "example_batch_record.pdf"
        )
        self.assertTrue(fixture.exists(), "Expected fixture PDF to exist")
        res = detector.detect_pdf(fixture.read_bytes(), max_pages=1)
        self.assertTrue(res["success"])
        suggestions = res["suggestions"]
        self.assertGreater(len(suggestions), 0)
        from_cell = [s for s in suggestions if s["fromCell"]]
        # Every cell-input should carry table provenance.
        for s in from_cell:
            self.assertIn("tableId", s)
            self.assertIn("cellRow", s)
            self.assertIn("cellCol", s)
            self.assertEqual(s["kind"], "cell_input")

    def test_example_pdf_no_duplicate_cell_inputs_per_cell(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2] / "data" / "imgs" / "example_batch_record.pdf"
        )
        res = detector.detect_pdf(fixture.read_bytes(), max_pages=2)
        from_cell = [s for s in res["suggestions"] if s.get("fromCell")]
        seen = set()
        for s in from_cell:
            key = (s["page"], s["tableId"], s["cellRow"], s["cellCol"])
            self.assertNotIn(key, seen, f"Duplicate cell field at {key}")
            seen.add(key)

    def test_debug_payload_shape(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2] / "data" / "imgs" / "example_batch_record.pdf"
        )
        res = detector.detect_pdf(fixture.read_bytes(), max_pages=1, include_debug=True)
        self.assertIn("debug", res)
        page = res["debug"]["pages"][0]
        self.assertIn("tables", page)
        self.assertIn("decisions", page)


if __name__ == "__main__":
    unittest.main()
