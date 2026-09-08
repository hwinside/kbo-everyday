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
ARTICLE = re.compile(r"(?m)^(\d{1,2}\.\d{2})[ \t]+([^\n]{1,80})$")
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
        yield marker.group(0).strip(), text[marker.end():end], marker.end(), end


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
    kept = [p for p in pages if not is_toc(p["text"])]
    starts, texts, pos = [], [], 0
    for page in kept:
        body = page_body(page["text"])
        starts.append((pos, page["page"]))
        texts.append(body)
        pos += len(body) + 1
    joined = "\n".join(texts)
    # The final conversion table and colophon are not part of WIND-UP POSITION.
    # Keep them in the audit as explicit exclusions, never under a rule title.
    tail = joined.find("<야구 도량형>")
    if tail < 0:
        raise ValueError("missing end-of-glossary boundary")
    excluded_tail = joined[tail:]
    joined = joined[:tail]
    offsets = [p[0] for p in starts]

    def page_of(offset):
        return starts[max(0, bisect.bisect_right(offsets, offset) - 1)][1]

    markers = sorted([*ARTICLE.finditer(joined), *TERM.finditer(joined), *APPENDIX.finditer(joined)], key=lambda m: m.start())
    if not markers:
        raise ValueError("no rule sections")
    result, audit_units = [], []

    def emit(title, body, start, end, provision=False):
        if not body.strip():
            return
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
        audit_units.append({"section": title, "start": start, "end": end,
                            "page": page_of(start), "pageEnd": page_of(max(start, end - 1)),
                            "chunks": len(result) - first, "payloadChars": len(compact(body)), "lostChars": 0})

    for title, body, start, end in sections(joined, markers):
        if title.startswith("5.09") or title.startswith("보칙"):
            subsections = list(SUBSECTION.finditer(body))
            boundaries = [("", body[:subsections[0].start()] if subsections else body, 0)]
            for i, sub in enumerate(subsections):
                stop = subsections[i+1].start() if i+1 < len(subsections) else len(body)
                boundaries.append((sub.group(0), body[sub.end():stop], sub.end()))
            for sub_title, sub_body, delta in boundaries:
                label = " / ".join(t for t in [title, sub_title] if t)
                items = list((APPENDIX_ITEM if title.startswith("보칙") else ITEM).finditer(sub_body))
                if not items:
                    emit(label, sub_body, start + delta, start + delta + len(sub_body), True)
                    continue
                lead = flatten(sub_body[:items[0].start()])
                for i, item in enumerate(items):
                    stop = items[i+1].start() if i+1 < len(items) else len(sub_body)
                    atom = sub_body[item.start():stop].strip()
                    emit(label + " / " + item.group(0).strip(), (lead + "\n" + atom).strip(),
                         start + delta + item.start(), start + delta + stop, True)
        else:
            emit(title, body, start, end)
    return result, {"extractor": REVISION, "sourcePages": len(pages),
                    "tocPages": len(pages)-len(kept), "markers": len(markers),
                    "chunks": len(result), "maxChunkChars": max(r["len"] for r in result),
                    "lostChars": 0, "units": audit_units,
                    "excluded": [
                        {"reason": "front matter before first rule", "chars": markers[0].start()},
                        {"reason": "conversion tables and colophon after glossary", "chars": len(excluded_tail)},
                    ]}


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
    print(json.dumps({k: v for k, v in audit.items() if k != "units"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
