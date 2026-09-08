#!/usr/bin/env python3
"""Real page fixtures for the offline official-rulebook producer."""
import importlib.util
import json
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "rulebook", ROOT / "scripts/baseball-qa/rag/prepare-rulebook-corpus.py")
rulebook = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(rulebook)
PAGES = json.loads((ROOT / "scripts/qa/fixtures/kbo-rulebook-boundary-pages.json").read_text())["pages"]


class Boundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rows, cls.audit = rulebook.prepare(PAGES)

    def test_short_marker_does_not_shift_later_body_offset(self):
        text = "1.01 첫 조문\n짧음\n2.01 다음 조문\n" + "두 번째 조문입니다. " * 8
        units = list(rulebook.sections(text, list(rulebook.ARTICLE.finditer(text))))
        self.assertEqual(len(units), 2)
        self.assertEqual(text[units[1][2]:units[1][3]], units[1][1])
        self.assertEqual(units[1][0], "2.01 다음 조문")

    def test_header_budget_and_short_tail_are_not_dropped(self):
        original = "완결된 조건과 판정입니다. " * 90 + "다음 문장입니다."
        chunks = rulebook.wrap("매우 긴 조문 제목" * 6, original)
        self.assertGreater(len(chunks), 1)
        self.assertEqual(rulebook.compact("".join(p for _, p in chunks)), rulebook.compact(original))
        self.assertTrue(all(len(c) <= 780 for c, _ in chunks))

    def test_indivisible_overflow_is_error_not_whitespace_cut(self):
        with self.assertRaisesRegex(ValueError, "indivisible"):
            rulebook.wrap("조문", "전제가 끝나지 않는 " * 200)

    def test_strike_premise_and_effect_share_one_serving_chunk(self):
        rows = [r for r in self.rows if r["section"].endswith("⒜ 타자 아웃 / ⑶")]
        self.assertEqual(len(rows), 1)
        text = rulebook.compact(rows[0]["text"])
        for expected in ["무사또는1사에1루주자가있을때", "포수가잡지못했을경우", "타자는아웃이다"]:
            self.assertIn(expected, text)
        self.assertEqual((rows[0]["page"], rows[0]["page_end"]), (75, 75))
        self.assertLessEqual(len(rows[0]["text"]), 800)

    def test_return_base_not_out_heading_and_genuine_out_retained(self):
        catcher = [r for r in self.rows if "포수또는다른야수가타자의타격을방해" in rulebook.compact(r["text"])]
        self.assertEqual(len(catcher), 1)
        self.assertTrue(catcher[0]["section"].startswith("보칙"))
        self.assertNotIn("5.09", catcher[0]["section"])
        self.assertIn("방해가 발생한 순간", catcher[0]["text"])
        self.assertEqual(catcher[0]["page"], 92)
        runner = [r for r in self.rows if r["section"].endswith("⒝ 주자 아웃 / ⑶")]
        self.assertTrue(runner)
        for row in runner:
            self.assertIn("주자는아웃되고볼데드가된다", rulebook.compact(row["text"]))

    def test_clauses_survive_page_breaks_without_running_headers(self):
        self.assertFalse(any("인 때도 같음)" == r["text"].split("\n")[-1][:8] for r in self.rows))
        self.assertTrue(all(40 <= r["len"] <= 780 for r in self.rows))
        self.assertTrue(all(r["atomic"] for r in self.rows))
        self.assertFalse(any("아 웃" in r["section"] for r in self.rows))
        self.assertEqual(self.audit["lostChars"], 0)

    def test_missing_or_duplicate_core_page_fails(self):
        with self.assertRaisesRegex(ValueError, "missing"):
            rulebook.prepare([r for r in PAGES if r["page"] != 75])
        with self.assertRaisesRegex(ValueError, "duplicate"):
            rulebook.prepare(PAGES + [PAGES[0]])


if __name__ == "__main__":
    unittest.main()
