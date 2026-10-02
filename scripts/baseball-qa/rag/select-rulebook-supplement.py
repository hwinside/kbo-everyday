#!/usr/bin/env python3
"""Select complete sections from the PDF-verified producer output, offline.

No question routing, authored rule summary, database write or embedding call.
Run prepare-rulebook-corpus.py first; its audit binds the full PDF and output.
"""
import argparse
import hashlib
import json
from pathlib import Path


def main():
    p = argparse.ArgumentParser(description=__doc__)
    for name in ("input", "audit", "output"):
        p.add_argument("--" + name, required=True, type=Path)
    p.add_argument("--section", required=True, action="append")
    args = p.parse_args()
    if args.output.resolve() in (args.input.resolve(), args.audit.resolve()):
        raise ValueError("output must not overwrite source")
    raw = args.input.read_bytes()
    audit = json.loads(args.audit.read_text())
    if (hashlib.sha256(raw).hexdigest() != audit["outputSha256"]
            or audit["lostChars"] != 0 or audit["pdfPagesVerified"] != 205
            or audit["extractor"] != "kbo-rulebook-boundaries-v3.1"):
        raise ValueError("unverified or incomplete source artifact")
    source = [json.loads(s) for s in raw.splitlines() if s.strip()]
    selected = [r for r in source if r["section"] in args.section]
    if set(r["section"] for r in selected) != set(args.section):
        raise ValueError("missing requested section")
    # All pieces of each section are selected. Never truncate to a desired count.
    result = []
    for i, original in enumerate(selected):
        r = dict(original)
        r.update(entity=r["title"] + " 필수 조항",
                 extractorRevision="kbo-required-regulations-v1",
                 sourcePdfSha256=audit["sourcePdfSha256"],
                 selection="required_articles", documentOrdinal=i,
                 documentChunkCount=len(selected))
        result.append(r)
    args.output.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in result))
    print(json.dumps({"sections": args.section, "chunks": len(result),
                      "sourcePdfSha256": audit["sourcePdfSha256"],
                      "outputSha256": hashlib.sha256(args.output.read_bytes()).hexdigest()}))


if __name__ == "__main__":
    main()
