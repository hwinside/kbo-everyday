#!/usr/bin/env python3
"""
다음(Daum) 스포츠 선수 원본 사진 다운로더 (히어로샷 고해상도 소스).

다음 선수 이미지 ID = 우리 KBO 로스터 kboId 와 동일 체계라 매핑 테이블이
필요 없다. 원본은 2000~3971px대(공홈 94×118 대비 면적 10배+).

  URL : https://t1.daumcdn.net/sports/player/300/1/{kboId}.jpg
  검증: person/rank.json 의 cpPersonId == 우리 kboId (2026-06-25 spike)

출력은 gitignore 작업 디렉토리(기본 scripts/hero/.daum-src)에만 받고,
커밋되는 건 build-hero.py 가 만드는 webp 뿐이다(원본 4MB는 미커밋).

Usage:
  fetch-daum-src.py                 # 로스터 전체
  fetch-daum-src.py --ids 77637,76715
  fetch-daum-src.py --out DIR       # 다운로드 경로 override
"""
import argparse
import json
import os
import sys
import time
import urllib.request

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
ROSTER = os.path.join(REPO, "src", "lib", "constants", "players-roster.json")
DEFAULT_OUT = os.path.join(os.path.dirname(__file__), ".daum-src")
URL = "https://t1.daumcdn.net/sports/player/300/1/{kbo_id}.jpg"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16 Safari/605.1.15",
    "Referer": "https://sports.daum.net/",
}
MIN_BYTES = 2000  # 그보다 작으면 깨진/플레이스홀더로 간주


def roster_ids():
    return [p["kboId"] for p in json.load(open(ROSTER, encoding="utf-8"))]


def fetch(kbo_id, out_dir):
    dest = os.path.join(out_dir, f"{kbo_id}.jpg")
    req = urllib.request.Request(URL.format(kbo_id=kbo_id), headers=HEADERS)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
    except Exception as e:
        return False, f"err {e.__class__.__name__}"
    if len(data) < MIN_BYTES:
        return False, f"too small ({len(data)}B)"
    with open(dest, "wb") as f:
        f.write(data)
    return True, f"{len(data)}B"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ids", help="comma-separated kboIds (기본: 로스터 전체)")
    ap.add_argument("--out", default=DEFAULT_OUT, help="다운로드 디렉토리")
    args = ap.parse_args()

    out_dir = os.path.abspath(args.out)
    os.makedirs(out_dir, exist_ok=True)
    ids = [x for x in args.ids.split(",") if x] if args.ids else roster_ids()

    ok, missing = 0, []
    for i, kid in enumerate(ids):
        good, msg = fetch(kid, out_dir)
        if good:
            ok += 1
        else:
            missing.append((kid, msg))
        if (i + 1) % 50 == 0:
            print(f"  ... {i + 1}/{len(ids)} (ok={ok})", flush=True)
        time.sleep(0.05)

    print(f"fetched={ok} missing={len(missing)} total={len(ids)} -> {out_dir}")
    for kid, msg in missing[:40]:
        print(f"  MISS {kid}: {msg}", file=sys.stderr)
    # 커버리지 리포트 파일(미커밋, 배치 판단용)
    json.dump(
        {"fetched": ok, "missing": [m[0] for m in missing], "total": len(ids)},
        open(os.path.join(out_dir, "_coverage.json"), "w", encoding="utf-8"),
        ensure_ascii=False, indent=2,
    )


if __name__ == "__main__":
    main()
