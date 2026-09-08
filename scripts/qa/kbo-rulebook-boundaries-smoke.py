#!/usr/bin/env python3
"""Real page fixtures for the offline official-rulebook producer."""
import importlib.util
import json
from pathlib import Path
import re
import unittest
from unittest.mock import patch

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

    def test_inline_clauses_are_body_not_truncated_titles(self):
        for number, phrase in [("1.02", "공격팀의 목적은"), ("1.05", "각 팀의 목적은"),
                               ("1.03", "수비팀의 목적은"), ("1.04", "타자가 주자가 되어"),
                               ("1.06", "정식경기가 끝났을 때")]:
            rows = [r for r in self.rows if r["section"] == number]
            self.assertEqual(len(rows), 1, number)
            self.assertTrue(rows[0]["text"].split("\n", 1)[1].startswith(phrase))
            self.assertEqual(rows[0]["page"], 25)
        self.assertIn("주자를진루시키는것이다.", rulebook.compact(next(r["text"] for r in self.rows if r["section"] == "1.02")))
        self.assertIn("득점하여승리하는데에있다.", rulebook.compact(next(r["text"] for r in self.rows if r["section"] == "1.05")))

    def test_cross_references_stay_with_glossary_terms(self):
        for term, reference in [("53. OFFICIAL SCORER", "9.00참조"),
                                ("64. REGULATION GAME", "7.01참조")]:
            rows = [r for r in self.rows if r["section"].startswith(term)]
            self.assertEqual(len(rows), 1)
            self.assertIn(reference, rulebook.compact(rows[0]["text"]))
        self.assertFalse(any(r["section"] in ["9.00 참조", "7.01 참조"] for r in self.rows))

    def test_chapter_exclusion_and_whole_source_accounting(self):
        chapters = [e for e in self.audit["excluded"] if e["reason"].startswith("standalone chapter")]
        self.assertTrue(any(e["section"] == "1.00 경기의 목적" and e["chars"] > 0 for e in chapters))
        self.assertEqual(self.audit["inputChars"], self.audit["retainedChars"] + self.audit["excludedChars"])
        self.assertEqual(self.audit["excludedChars"], sum(e["chars"] for e in self.audit["excluded"]))
        sections = rulebook.sections
        def dropped_clause(*args):
            return (unit for unit in sections(*args) if unit[0] != "1.02")
        with patch.object(rulebook, "sections", dropped_clause):
            with self.assertRaises(ValueError):
                rulebook.prepare(PAGES)

    def test_long_inline_line_and_heading_only_item_are_retained(self):
        text = "1.02 " + "타자는 주자가 된다. " * 10 + "\n2.01 다음 조문\n본문"
        units = list(rulebook.sections(text, list(rulebook.ARTICLE.finditer(text))))
        self.assertEqual(units[0][0], "1.02")
        self.assertEqual(rulebook.compact(units[0][1]), rulebook.compact("타자는 주자가 된다. " * 10))
        extra = {**PAGES[0], "page": 26, "text": "1.07 제목에만 있는 완결된 규칙 문장을 빠짐없이 원문 그대로 보존하여야 한다.\n"}
        rows, _ = rulebook.prepare(PAGES + [extra])
        self.assertTrue(any(r["section"] == "1.07" and "원문 그대로 보존하여야 한다." in r["text"] for r in rows))

    def test_long_bilingual_label_is_not_mistaken_for_a_sentence(self):
        label = "9.11 더블 플레이(DOUBLE PLAY)·트리플 플레이(TRIPLE PLAY)"
        text = label + "\n공식기록원은 기록한다."
        units = list(rulebook.sections(text, list(rulebook.ARTICLE.finditer(text))))
        self.assertEqual(units[0][0], label)
        self.assertEqual(units[0][1].strip(), "공식기록원은 기록한다.")


if __name__ == "__main__":
    unittest.main()
