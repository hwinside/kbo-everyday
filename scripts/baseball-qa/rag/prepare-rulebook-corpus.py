#!/usr/bin/env python3
"""Rebuild the 2026 rulebook from page JSONL, offline (never writes a database).

Unlike the historical v2 script, offsets travel with their text, PDF running
headers are not article boundaries, and the heading is included in the serving
budget. Oversized indivisible text is an error, never a silent skipped row.
"""
import argparse
import bisect
import hashlib
import json
import re
from pathlib import Path

TITLE = "2026 공식야구규칙"
FILE = "2026_야구규칙.pdf"
REVISION = "kbo-rulebook-boundaries-v3"
MAX_CHARS = 780  # Below both loader (900) and selected-evidence (800) caps.
ARTICLE = re.compile(r"(?m)^(\d{1,2}\.\d{2})[ \t]+(?!참조[ \t]*$)([^\n]+)$")
TERM = re.compile(r"(?m)^\d{1,3}\.\s+[A-Z][A-Z '\-/]{2,40}\s*\([^\n)]{1,40}\)")
APPENDIX = re.compile(r"(?m)^보칙\s*:\s*볼 데드일 때 주자의 귀루에 관한 조치[^\n]*")
SUBSECTION = re.compile(r"(?m)^⒜ 타자 아웃|^⒝ 주자 아웃|^⒞ 어필 플레이|^⒟ 선행주자가 베이스에 닿지 못했을 때|^⒠ 공수교대|^투수가 투구할 당시에 점유하고 있던 베이스로 돌아가는 경우|^방해가 발생한 순간 점유하고 있던 베이스로 되돌려 보내는 경우")
ITEM = re.compile(r"(?m)^[⑴-⒇]\s+")
APPENDIX_ITEM = re.compile(r"(?m)^[⒜-⒵]\s+")
NOTE = re.compile(r"\[(?:원주|주\d*|예\d*|문|답|부기|규칙설명)\]")


def compact(text):
    return re.sub(r"\s+", "", text)


def flatten(text):
    return re.sub(r"\s+", " ", text).strip()


def page_body(text):
    lines = text.replace("\r\n", "\n").replace("\x00", "").splitlines()
    # The first line is a mirrored running title, not the article's own title.
    if len(lines) >= 2 and re.fullmatch(r"[․·\s]*\d+[․·\s]*", lines[1]):
        lines = lines[2:]
    elif lines and re.fullmatch(r"[․·\s]*\d+[․·\s]*", lines[0]):
        lines = lines[1:]
    return "\n".join(lines).strip()


def is_toc(text):
    return text.count("····") + text.count("․․․․") + len(re.findall(r"\.{4,}", text)) >= 3


def sections(text, markers):
    """Keep the marker, body and offset together, even for a short section."""
    for i, marker in enumerate(markers):
        end = markers[i + 1].start() if i + 1 < len(markers) else len(text)
        title, start = marker.group(0).strip(), marker.end()
        # This book's 1.01–1.06 are declarations, not labels. Keep their full
        # first line with the PDF-wrapped body. Do not mistake long bilingual
        # labels (e.g. 9.11/9.13/9.17) for prose based on length alone.
        if marker.re is ARTICLE and (re.fullmatch(r"1\.0[1-6]", marker.group(1)) or
                                     re.search(r"다\.|[!?。]", marker.group(2))):
            title, start = marker.group(1), marker.start(2)
        yield title, text[start:end], start, end, marker.start()


def content_accounting(text, coverage):
    """Independent source-span accounting; an unvisited unit is a hard error."""
    counts = {"retainedChars": 0, "excludedChars": 0, "lostChars": 0}
    for char, state in zip(text, coverage):
        if char.isspace():
            continue
        if state == 3:
            raise ValueError("source span both retained and excluded")
        counts[{0: "lostChars", 1: "retainedChars", 2: "excludedChars"}[state]] += 1
    if len(text) != len(coverage) or counts["lostChars"]:
        raise ValueError(f"unaccounted source content: {counts['lostChars']} characters")
    return counts


def sentence_parts(text):
    # PDF line wraps are never sentence boundaries. Neither is a rule-number dot.
    text = flatten(text)
    return [p for p in re.split(r"(?<=[.!?。])\s+(?=[^0-9])", text) if p]


def wrap(title, text, context=""):
    prefix = TITLE + " / " + title + ("\n" + context if context else "")
    budget = MAX_CHARS - len(prefix) - 1
    if budget < 80:
        raise ValueError(f"context exceeds serving budget: {title}")
    parts = sentence_parts(text)
    result, buf = [], ""
    for part in parts:
        if len(part) > budget:
            raise ValueError(f"indivisible text ({len(part)} > {budget}): {title}: {part[:90]}")
        if buf and len(buf) + len(part) + 1 > budget:
            result.append((prefix + "\n" + buf, buf))
            buf = ""
        buf = f"{buf} {part}".strip()
    if buf:
        result.append((prefix + "\n" + buf, buf))
    if compact("".join(payload for _, payload in result)) != compact(text):
        raise ValueError(f"content accounting mismatch: {title}")
    return result


def provision_chunks(title, body):
    """Keep operative clause + notes together when small; repeat clause if split.

    The prefix is copied from the provision, never an application-written legal
    summary. This keeps 5.09(a)(3)'s outs/base premise with its third-strike note.
    """
    body = flatten(body)
    heading = TITLE + " / " + title
    if len(heading) + len(body) + 1 <= MAX_CHARS:
        return [(heading + "\n" + body, body)]
    note = NOTE.search(body)
    if note is None:
        return wrap(title, body)
    operative, commentary = body[:note.start()].strip(), body[note.start():].strip()
    if len(operative) + len(title) > 500:
        return wrap(title, body)
    # The operative text is served independently as well as carried as context.
    result = [(heading + "\n" + operative, operative)]
    result.extend(wrap(title, commentary, operative))
    return result


def prepare(rows):
    pages = sorted((r for r in rows if r.get("file") == FILE), key=lambda r: r["page"])
    if not pages or any(r.get("title") != TITLE or r.get("pages_total") != 220 for r in pages):
        raise ValueError("expected the 220-page 2026 official rulebook page extraction")
    numbers = [r["page"] for r in pages]
    if len(set(numbers)) != len(numbers) or not set(range(74, 94)).issubset(numbers):
        raise ValueError("duplicate pages or missing 5.09/appendix source page")
    excluded = []

    def record_exclusion(reason, text, **metadata):
        if compact(text):
            excluded.append({"reason": reason, "chars": len(compact(text)),
                             "sha256": hashlib.sha256(compact(text).encode()).hexdigest(), **metadata})

    kept = []
    for page in pages:
        if is_toc(page["text"]):
            record_exclusion("table of contents", page["text"], page=page["page"])
        else:
            kept.append(page)
    starts, texts, pos = [], [], 0
    for page in kept:
        body = page_body(page["text"])
        raw = page["text"].replace("\x00", "")
        removed = len(compact(raw)) - len(compact(body))
        if removed:
            # page_body only removes a prefix (mirrored title/page number).
            raw_prefix = compact(raw)[:removed]
            if raw_prefix + compact(body) != compact(raw):
                raise ValueError("unexpected non-prefix page cleanup")
            record_exclusion("running header and page number", raw_prefix, page=page["page"])
        starts.append((pos, page["page"]))
        texts.append(body)
        pos += len(body) + 1
    joined = "\n".join(texts)
    # The final conversion table and colophon are not part of WIND-UP POSITION.
    # Keep them in the audit as explicit exclusions, never under a rule title.
    tail = joined.find("<야구 도량형>")
    if tail < 0:
        raise ValueError("missing end-of-glossary boundary")
    coverage = bytearray(len(joined))
    offsets = [p[0] for p in starts]

    def page_of(offset):
        return starts[max(0, bisect.bisect_right(offsets, offset) - 1)][1]

    markers = sorted([*ARTICLE.finditer(joined, 0, tail), *TERM.finditer(joined, 0, tail),
                      *APPENDIX.finditer(joined, 0, tail)], key=lambda m: m.start())
    if not markers:
        raise ValueError("no rule sections")
    result, audit_units = [], []

    def cover(start, end, state=1):
        for index in range(start, end):
            coverage[index] |= state

    def exclude(reason, start, end, **metadata):
        cover(start, end, 2)
        record_exclusion(reason, joined[start:end], page=page_of(start), **metadata)

    exclude("front matter before first rule", 0, markers[0].start())
    exclude("conversion tables and colophon after glossary", tail, len(joined))

    def emit(title, body, start, end, provision=False, lead=""):
        if not body.strip():
            return
        if compact(body) != compact(lead + joined[start:end]):
            raise ValueError(f"source/payload mismatch: {title}")
        chunks = provision_chunks(title, body) if provision else wrap(title, body)
        if compact("".join(payload for _, payload in chunks)) != compact(body):
            raise ValueError(f"unit loss: {title}")
        first = len(result)
        for text, _ in chunks:
            if not 40 <= len(text) <= MAX_CHARS:
                raise ValueError(f"bad chunk length: {title}")
            index = len(result)
            result.append({
                "source": "kbo_official", "doc": f"{TITLE}#{title}#{index}",
                "kind": "rule", "entity": TITLE, "title": TITLE,
                "section": title, "unit": "complete_rule", "atomic": True,
                "page": page_of(start), "page_end": page_of(max(start, end - 1)),
                "pages_total": 220, "file": FILE, "len": len(text), "text": text,
                "fetchedAt": pages[0]["fetchedAt"], "extractorRevision": REVISION,
            })
        cover(start, end)
        audit_units.append({"section": title, "start": start, "end": end,
                            "page": page_of(start), "pageEnd": page_of(max(start, end - 1)),
                            "chunks": len(result) - first, "payloadChars": len(compact(body)), "lostChars": 0})

    for title, body, start, end, heading_start in sections(joined[:tail], markers):
        first = len(result)
        if not body.strip():
            if re.fullmatch(r"\d{1,2}\.00[ \t]+.+", title):
                exclude("standalone chapter heading; provisions served separately", heading_start, end, section=title)
                continue
            # A title-only substantive item must be emitted, never silently lost.
            body, start = joined[heading_start:end], heading_start
        if title.startswith("5.09") or title.startswith("보칙"):
            subsections = list(SUBSECTION.finditer(body))
            boundaries = [("", body[:subsections[0].start()] if subsections else body, 0, 0)]
            for i, sub in enumerate(subsections):
                stop = subsections[i+1].start() if i+1 < len(subsections) else len(body)
                boundaries.append((sub.group(0), body[sub.end():stop], sub.end(), sub.start()))
            for sub_title, sub_body, delta, sub_heading_start in boundaries:
                sub_first = len(result)
                label = " / ".join(t for t in [title, sub_title] if t)
                items = list((APPENDIX_ITEM if title.startswith("보칙") else ITEM).finditer(sub_body))
                if not items:
                    emit(label, sub_body, start + delta, start + delta + len(sub_body), True)
                else:
                    lead = flatten(sub_body[:items[0].start()])
                    for i, item in enumerate(items):
                        stop = items[i+1].start() if i+1 < len(items) else len(sub_body)
                        atom = sub_body[item.start():stop].strip()
                        emit(label + " / " + item.group(0).strip(), (lead + "\n" + atom).strip(),
                             start + delta + item.start(), start + delta + stop, True, lead)
                    cover(start + delta, start + delta + items[0].start())
                if len(result) > sub_first:
                    cover(start + sub_heading_start, start + delta)
        else:
            emit(title, body, start, end)
        if len(result) > first:
            if not all(compact(title) in compact(r["text"]) for r in result[first:]):
                raise ValueError(f"heading not retained: {title}")
            cover(heading_start, start)
    accounting = content_accounting(joined, coverage)
    input_chars = sum(len(compact(p["text"].replace("\x00", ""))) for p in pages)
    excluded_chars = sum(e["chars"] for e in excluded)
    if input_chars != accounting["retainedChars"] + excluded_chars:
        raise ValueError("page/source accounting mismatch")
    return result, {"extractor": REVISION, "sourcePages": len(pages),
                    "tocPages": len(pages)-len(kept), "markers": len(markers),
                    "chunks": len(result), "maxChunkChars": max(r["len"] for r in result),
                    "inputChars": input_chars, "retainedChars": accounting["retainedChars"],
                    "excludedChars": excluded_chars, "lostChars": accounting["lostChars"],
                    "units": audit_units, "excluded": excluded}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--pdf", required=True, type=Path,
                        help="Original 2026 PDF; page text must match the JSONL")
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--audit", required=True, type=Path)
    args = parser.parse_args()
    if args.input.resolve() in [args.output.resolve(), args.audit.resolve()]:
        raise ValueError("output must not overwrite source")
    raw = args.input.read_bytes()
    source = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if sum(r.get("file") == FILE for r in source) != 205:
        raise ValueError("refusing a partial rulebook replacement: expected 205 extracted pages")
    from pypdf import PdfReader
    pdf_bytes = args.pdf.read_bytes()
    pdf = PdfReader(args.pdf)
    if len(pdf.pages) != 220:
        raise ValueError("unexpected source PDF page count")
    for page in (r for r in source if r.get("file") == FILE):
        number = page["page"]
        if not isinstance(number, int) or not 1 <= number <= len(pdf.pages):
            raise ValueError("invalid physical PDF page")
        if compact(page["text"].replace("\x00", "")) != compact((pdf.pages[number-1].extract_text() or "").replace("\x00", "")):
            raise ValueError(f"PDF/JSONL text mismatch at physical page {number}")
    rows, audit = prepare(source)
    audit["inputSha256"] = hashlib.sha256(raw).hexdigest()
    audit["sourcePdfSha256"] = hashlib.sha256(pdf_bytes).hexdigest()
    audit["pdfPagesVerified"] = 205
    data = "".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows)
    audit["outputSha256"] = hashlib.sha256(data.encode()).hexdigest()
    args.output.write_text(data, encoding="utf-8")
    args.audit.write_text(json.dumps(audit, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in audit.items() if k not in ["units", "excluded"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
