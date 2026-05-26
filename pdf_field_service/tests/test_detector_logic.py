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
        self.assertEqual(s["fieldType"], "number")
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
        labels = {s["labelText"] for s in row1}
        self.assertIn("Initials", labels)
        self.assertIn("Date", labels)
        # Row id is retained as metadata for downstream grouping.
        row_ids = {s.get("rowId") for s in row1}
        self.assertEqual(row_ids, {"Mixer A"})


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
        labels = {s["labelText"] for s in page2}
        self.assertTrue(
            {"Time", "Temperature", "Operator"}.issubset(labels),
            f"Expected inherited column headers, got {labels}",
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
        dates = [l for l in labels if l == "date"]
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
