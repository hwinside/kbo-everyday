#!/usr/bin/env python3
"""마스코트 영상 모션 파생 빌드 — SSOT → public/mascot/motion (재현 가능).

사용:  python3 scripts/assets/build-mascot-motion.py [--check]
  (기본)   파생 자산 26개 + DERIVED.json 을 새로 쓴다.
  --check  현재 커밋된 자산이 이 스크립트로 재현되는지만 검사한다(쓰기 없음).

왜 스크립트를 커밋하나 (삼순 #1228 P1):
  파생 WebP 만 있으면 "이 26개가 어디서 어떻게 나왔는가"를 아무도 재현할 수 없다.
  자산을 다시 뽑아야 할 때(해상도 변경·fps 변경·SSOT 갱신) 손으로 다시 만들면
  그때마다 다른 결과가 나온다.

⚠️ 2벌 역산(black+white 연립방정식으로 알파를 정확히 구하는 방법)을 먼저 시도했고
   **13종 중 3종만 성공**해서 폐기했다. black/white 인코딩에서 WebP 중복 프레임 제거
   개수가 달라 프레임 수가 어긋난다(bored 119 vs 121, swing 98 vs 120, cheerD 90 vs 100).
   → 8/5 에 검증된 flood-fill 키잉(외곽 연결성 판정)으로 전환.
     밝기 threshold 는 유니폼·모자가 남색이라 캐릭터 몸이 같이 날아간다(8/5 실측).

⚠️ 프레임 duration 은 원본에서 **읽어서** 계산한다 — 상수로 박으면 SSOT 가 다른
   타이밍으로 갱신됐을 때 조용히 어긋난다.
"""
import argparse
import hashlib
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

# SSOT — 8/7 고정본(MANIFEST.sha256 포함). repo 밖이라 경로를 env 로 덮을 수 있다.
SSOT = os.environ.get("MASCOT_SSOT", os.path.expanduser("~/.openclaw/workspace/assets/mascot/v1"))
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "mascot", "motion")
MANIFEST = os.path.join(OUT, "DERIVED.json")

TOL = 26          # 배경 색 허용 오차
TARGET_H = 192    # 2x 자산 (렌더 96px)
STEP = 2          # 24fps → 12fps
QUALITY = 62


def key_frame(rgb: np.ndarray) -> np.ndarray:
    """flood-fill 키잉 — 네 모서리 색과 **외곽에 연결된** 영역만 배경으로 본다.

    단순 색 거리 판정이면 캐릭터 안쪽의 같은 색 픽셀(모자·유니폼 그림자)까지
    뚫려서 구멍이 난다. 연결성을 봐야 안쪽이 살아남는다.
    """
    a = rgb.astype(np.int16)
    h, w, _ = a.shape
    bgc = np.median(np.array([a[2, 2], a[2, w - 3], a[h - 3, 2], a[h - 3, w - 3]]), axis=0)
    lab, _ = ndimage.label(np.abs(a - bgc).max(axis=2) <= TOL)
    edge = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    al = (~np.isin(lab, list(edge))).astype(np.uint8) * 255
    # 경계 1px 을 부드럽게 — 계단현상 제거. 배경 쪽은 0.55 로 눌러 halo 를 줄인다.
    af = ndimage.uniform_filter(al.astype(np.float32), size=3)
    return np.where(al > 0, np.maximum(al, af), af * 0.55).clip(0, 255).astype(np.uint8)


def build(name: str):
    src = os.path.join(SSOT, f"{name}-black.webp")
    im = Image.open(src)
    raw, durs = [], []
    for i in range(im.n_frames):
        im.seek(i)
        raw.append(np.asarray(im.convert("RGB")).astype(np.float32))
        durs.append(im.info.get("duration", 42))
    idx = list(range(0, len(raw), STEP))
    alphas = [key_frame(raw[i]) for i in idx]

    # union bbox — 전 프레임 합집합으로 잘라야 동작 중 캐릭터가 잘리지 않는다.
    st = np.stack([a > 96 for a in alphas])
    ys, xs = np.where(st.any(axis=0))
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    bw, bh = x1 - x0, y1 - y0
    nw = max(1, round(bw * TARGET_H / bh))

    out = []
    for k, i in enumerate(idx):
        al = (alphas[k][y0:y1, x0:x1].astype(np.float32) / 255.0)[..., None]
        c = raw[i][y0:y1, x0:x1]
        # 검정 배경 합성본이므로 premultiplied 로 보고 un-premultiply → 검정 fringe 제거.
        est = np.clip(np.where(al > 0.02, c / np.maximum(al, 0.02), c), 0, 255)
        rgba = np.concatenate([est, al * 255], axis=2).astype(np.uint8)
        out.append(Image.fromarray(rgba).resize((nw, TARGET_H), Image.LANCZOS))

    dur = sum(durs[i] for i in idx[:2]) if len(idx) > 1 else durs[0] * STEP
    return out, {"frames": len(out), "w": nw, "h": TARGET_H, "duration_ms": dur,
                 "source_frames": len(raw)}


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="재현 검사만(쓰기 없음)")
    args = ap.parse_args()

    if not os.path.isdir(SSOT):
        print(f"SSOT 없음: {SSOT}", file=sys.stderr)
        print("  → MASCOT_SSOT 로 경로를 지정하거나 8/7 고정본을 준비하세요.", file=sys.stderr)
        return 2

    names = sorted({f.rsplit("-", 1)[0] for f in os.listdir(SSOT) if f.endswith("-black.webp")})
    if not names:
        print(f"SSOT 에 -black.webp 가 없음: {SSOT}", file=sys.stderr)
        return 2

    outdir = os.path.abspath(OUT)
    tmpdir = outdir if not args.check else os.path.join("/tmp", "mascot-motion-check")
    os.makedirs(tmpdir, exist_ok=True)

    report, mismatched = {}, []
    for n in names:
        frames, meta = build(n)
        clip = os.path.join(tmpdir, f"{n}.webp")
        poster = os.path.join(tmpdir, f"{n}-poster.webp")
        frames[0].save(clip, save_all=True, append_images=frames[1:], duration=meta["duration_ms"],
                       loop=0, format="WEBP", quality=QUALITY, method=6)
        # poster = 첫 프레임 정지본. reduced-motion 에서 자산 교체로 실제 정지시킨다.
        frames[0].save(poster, format="WEBP", quality=QUALITY, method=6, lossless=False)
        meta["clip_sha256"] = sha256(clip)
        meta["poster_sha256"] = sha256(poster)
        meta["clip_kb"] = round(os.path.getsize(clip) / 1024)
        report[n] = meta
        if args.check:
            for kind, built in (("clip", clip), ("poster", poster)):
                shipped = os.path.join(outdir, os.path.basename(built))
                if not os.path.exists(shipped) or sha256(shipped) != sha256(built):
                    mismatched.append(os.path.basename(built))
        print(f'{n:12s} {meta["frames"]:3d}f {meta["w"]:3d}x{meta["h"]} '
              f'{meta["clip_kb"]:5d}KB dur={meta["duration_ms"]}ms', flush=True)

    payload = {
        "generator": "scripts/assets/build-mascot-motion.py",
        "ssot": "assets/mascot/v1 (2026-08-07 고정, MANIFEST.sha256)",
        "params": {"target_h": TARGET_H, "frame_step": STEP, "quality": QUALITY, "tol": TOL},
        "clips": report,
    }
    if args.check:
        if mismatched:
            print(f"\n❌ 재현 불일치 {len(mismatched)}건: {', '.join(mismatched[:6])}", file=sys.stderr)
            return 1
        print(f"\n✅ 파생 자산 {len(names) * 2}개가 이 스크립트로 재현됨")
        return 0

    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    tot = sum(r["clip_kb"] for r in report.values())
    print(f"\n합계 {tot}KB · manifest → {os.path.relpath(MANIFEST)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
