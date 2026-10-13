#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare an explicitly scoped supplement from verified 2026 KBO PDFs.

No database/provider access. Existing sources are not replacement targets.
All selected article text, including historical conditions and exceptions, is
accounted for; chapter/paragraph premises are repeated, never synthesized.
"""
import argparse
import bisect
import hashlib
import json
import logging
import re
from pathlib import Path

REVISION = "kbo-required-regulations-v1"
MAX_CHARS = 780
PROFILES = {
    "league": {
        "file": "2026_리그규정.pdf", "title": "2026 KBO 리그 규정", "pages": 106,
        "sha256": "9a0c2f21cad8c69b5bbfae3658f3057edbb317feb74c9f2a1dca1931a4d0d156",
        "articles": {1: (13, "제1장 KBO 정규시즌"), 30: (44, "제2장 KBO 와일드카드 결정전"),
                     34: (46, "제3장 KBO 준플레이오프"), 38: (48, "제4장 KBO 플레이오프"),
                     42: (50, "제5장 KBO 한국시리즈"), 46: (52, "제5장 KBO 한국시리즈")},
    },
    "constitution": {
        "file": "2026_야구규약.pdf", "title": "2026 KBO 야구규약", "pages": 268,
        "sha256": "127a572cb35b6819f219eea3e5144695403239f4934d36141b40ad63006a9cff",
        "articles": {161: (93, "제17장 프리에이전트(FA)"), 162: (93, "제17장 프리에이전트(FA)"),
                     163: (95, "제17장 프리에이전트(FA)"), 164: (95, "제17장 프리에이전트(FA)")},
    },
}
ARTICLE = re.compile(r"(?m)^제[ \t]*(\d+)[ \t]*조(?:의[ \t]*\d+)?[ \t]+[^\n]+")
BRACKET_ARTICLE = re.compile(r"(?m)^제[ \t]*(\d+)[ \t]*조(?:의[ \t]*\d+)?[ \t]+(?:\[[^\]\n]+\]|\([^\)\n]+\))")
CHAPTER = re.compile(r"(?m)^제[ \t]*\d+[ \t]*장[ \t]+[^\n]+")
PARAGRAPH = re.compile(r"[①-⑳]")
NUMBERED = re.compile(r"(?m)^[ \t]*\d+\.[ \t]+(?!\d)")

def compact(text):
    return re.sub(r"\s+", "", text)

def flatten(text):
    return re.sub(r"\s+", " ", text).strip()

def page_body(text):
    lines = text.replace("\r\n", "\n").replace("\x00", "").splitlines()
    if lines and re.fullmatch(r"\s*\d+\s*", lines[0]):
        lines = lines[1:]
    return "\n".join(lines).strip()

def article_heading(marker):
    # Bracketed titles may share a PDF line with the first operative paragraph.
    value = marker.group(0)
    end = next((value.index(ch) + 1 for ch in ["]", ")"] if ch in value), len(value))
    return value[:end].strip(), marker.start() + end

def split_units(body):
    """Split paragraph markers; keep the actual paragraph preamble with each
    numbered child if a long paragraph must be divided. No word-list rewrite."""
    marks = list(PARAGRAPH.finditer(body))
    if not marks:
        return [(body, "", 0, len(body))]
    units = []
    if body[:marks[0].start()].strip():
        units.append((body[:marks[0].start()], "", 0, marks[0].start()))
    for i, mark in enumerate(marks):
        end = marks[i+1].start() if i+1 < len(marks) else len(body)
        units.append((body[mark.start():end], "", mark.start(), end))
    return units

def fit_units(body, budget):
    """Prefer intact paragraphs. Oversized numbered provisions retain their
    full operative preamble in every child, including date applicability."""
    result = []
    for text, context, start, end in split_units(body):
        if len(flatten(text)) <= budget:
            result.append((text, context, start, end))
            continue
        numbered = list(NUMBERED.finditer(text))
        if not numbered:
            raise ValueError("indivisible selected paragraph exceeds budget: " + flatten(text)[:100])
        premise = text[:numbered[0].start()]
        if not premise.strip() or len(flatten(premise)) > budget - 80:
            raise ValueError("missing/oversized operative premise")
        # The preamble is counted once in source coverage and repeated as context.
        result.append((premise, "", start, start + numbered[0].start()))
        for i, mark in enumerate(numbered):
            finish = numbered[i+1].start() if i+1 < len(numbered) else len(text)
            child = text[mark.start():finish]
            if len(flatten(premise)) + len(flatten(child)) + 1 > budget:
                raise ValueError("numbered provision + premise exceeds serving budget")
            result.append((child, premise, start + mark.start(), start + finish))
    return result

def prepare(profile, pages):
    if len(pages) != profile["pages"]:
        raise ValueError("all physical source pages are required")
    bodies = [page_body(text) for text in pages]
    offsets, joined = [], ""
    for body in bodies:
        offsets.append(len(joined)); joined += body + "\n\n"
    page_of = lambda pos: bisect.bisect_right(offsets, pos)
    # Constitution article headings are bracketed. Bare references such as
    # "제162조 제2항" at a wrapped line start are not new article boundaries.
    pattern = BRACKET_ARTICLE if profile["file"] == "2026_야구규약.pdf" else ARTICLE
    markers = list(pattern.finditer(joined))
    chapters = list(CHAPTER.finditer(joined))
    rows, articles = [], []
    for number, (expected_page, chapter) in profile["articles"].items():
        matches = [(i, m) for i, m in enumerate(markers) if int(m.group(1)) == number and page_of(m.start()) == expected_page]
        if len(matches) != 1:
            raise ValueError("selected article missing/ambiguous: " + str(number))
        index, marker = matches[0]
        if index + 1 >= len(markers) or int(markers[index+1].group(1)) != number + 1:
            raise ValueError("selected article's successor is not the next article: " + str(number))
        title, start = article_heading(marker)
        end = markers[index+1].start() if index+1 < len(markers) else len(joined)
        before = [c for c in chapters if c.start() < marker.start()]
        actual_chapter = before[-1] if before else None
        if not actual_chapter or compact(actual_chapter.group(0)) != compact(chapter):
            raise ValueError("chapter scope mismatch: " + title)
        next_chapter = next((c for c in chapters if start <= c.start() < end), None)
        if next_chapter: end = next_chapter.start()
        body = joined[start:end]
        section = chapter + " > " + title
        prefix = profile["title"] + " / " + section
        budget = MAX_CHARS - len(prefix) - 1
        spans = fit_units(body, budget)
        coverage = bytearray(len(body))
        count_before = len(rows)
        for payload, context, a, b in spans:
            for pos in range(a, b): coverage[pos] = 1
            content = prefix + "\n" + (flatten(context) + " " if context else "") + flatten(payload)
            if not 40 <= len(content) <= MAX_CHARS:
                raise ValueError("selected output outside serving budget")
            # The repeated chapter can be earlier than the main article; record
            # the full physical range of evidence actually copied into this row.
            rows.append({"source": "kbo_official", "file": profile["file"], "title": profile["title"],
                "entity": profile["title"] + " 필수 조항", "kind": "rule", "pages_total": profile["pages"],
                "page": page_of(actual_chapter.start()), "page_end": page_of(start + b - 1),
                "article_page": expected_page, "article_number": number, "section": section,
                "text": content, "atomic": True, "extractorRevision": REVISION,
                "sourcePdfSha256": profile["sha256"], "selection": "required_articles",
                "payloadSha256": hashlib.sha256(compact(payload).encode()).hexdigest()})
        missing = sum(1 for c, covered in zip(body, coverage) if not c.isspace() and not covered)
        if missing: raise ValueError("selected source text lost: " + title)
        if compact("".join(x[0] for x in spans)) != compact(body):
            raise ValueError("selected source order/accounting mismatch: " + title)
        articles.append({"number": number, "chapter": chapter, "title": title, "page": expected_page,
            "pageEnd": page_of(end - 1), "sourceText": body.strip(), "sourceChars": len(compact(body)),
            "outputChunks": len(rows) - count_before, "lostChars": missing})
    for ordinal, row in enumerate(rows):
        row["documentChunkCount"] = len(rows); row["documentOrdinal"] = ordinal
    return rows, {"selection": "required_articles_not_full_book", "articles": articles,
        "sourcePdfSha256": profile["sha256"], "selectedChars": sum(a["sourceChars"] for a in articles),
        "lostChars": 0, "chunks": len(rows), "maxChars": max(len(r["text"]) for r in rows)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league-pdf", type=Path, required=True)
    parser.add_argument("--constitution-pdf", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--audit", type=Path, required=True)
    parser.add_argument("--fetched-at", required=True, help="Recorded retrieval time, not an inferred effective date")
    args = parser.parse_args()
    from pypdf import PdfReader
    warnings = []
    class Capture(logging.Handler):
        def emit(self, record): warnings.append(record.getMessage())
    logger = logging.getLogger("pypdf"); capture = Capture(); logger.addHandler(capture)
    rows, audits = [], {}
    for key in ("league", "constitution"):
        p = getattr(args, key + "_pdf")
        if p.resolve() in [args.output.resolve(), args.audit.resolve()]: raise ValueError("output overwrites source")
        profile = PROFILES[key]
        if hashlib.sha256(p.read_bytes()).hexdigest() != profile["sha256"]:
            raise ValueError("PDF differs from reviewed source: " + key)
        reader = PdfReader(str(p))
        generated, audit = prepare(profile, [page.extract_text() or "" for page in reader.pages])
        for row in generated: row["fetchedAt"] = args.fetched_at
        rows.extend(generated); audits[key] = audit
    data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    audits["outputSha256"] = hashlib.sha256(data.encode()).hexdigest()
    audits["parserWarnings"] = warnings
    args.output.write_text(data, encoding="utf-8")
    args.audit.write_text(json.dumps(audits, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"chunks": len(rows), "maxChars": max(len(r['text']) for r in rows), "sha256": audits['outputSha256'], "parserWarnings": len(warnings)}, ensure_ascii=False))

if __name__ == "__main__": main()
