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

⚠️ 프레임 duration 은 **12fps 고정**이다 (삼순 #1228 4축-①).
   종전에는 "원본 타이밍 보존"이라며 원본 duration 을 합산했는데, SSOT WebP 의
   frame duration 이 **전 종 0** 이라(실측) 합산이 무의미했고 100~200ms 로 제각각
   갈렸다. 재생 속도가 종마다 다르면 같은 마스코트가 클립마다 다른 인물처럼 보인다.
   12fps = 83.33ms → 정수로 쓸 수 없으므로 **83/84 를 번갈아** 넣어 평균을 맞춘다.
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
# 12fps = 83.33ms/frame. 정수만 쓸 수 있어 83/84 를 번갈아 넣어 평균을 맞춘다.
FRAME_MS = (83, 84)


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

    # ⚠️ Pillow WebP 인코더는 **연속된 동일 프레임을 하나로 합치고 duration 을 더한다.**
    #    그러면 83+84=167ms 짜리 프레임이 생겨 "전 프레임 12fps" 계약이 깨진다
    #    (실측: pitching·thinking·cheerD 각 1프레임). 원본에 정지 구간이 있으면 발생한다.
    #    투명 코너 픽셀의 alpha 를 흔들어 동일 판정을 깬다 — 완전 투명 영역이라
    #    화면에는 아무 차이가 없다.
    #    ⚠️ **RGB 만 흔들면 소용없다** — alpha=0 픽셀의 RGB 는 lossy 인코딩이 평탄화해
    #       병합이 되살아난다(실측: cheerD·pitching·thinking 각 1프레임 잔존).
    #       WebP 는 **alpha 채널을 무손실로** 저장하므로 alpha 를 1~3 으로 흔든다.
    #       alpha 1/255 ≈ 0.4% 불투명 — 화면에서는 보이지 않는다.
    for i in range(len(out)):
        px = out[i].load()
        px[0, 0] = (0, 0, 0, 1 + (i % 3))

    # 프레임별 duration — 83/84 교대. Pillow 는 리스트를 받아 프레임마다 적용한다.
    durations = [FRAME_MS[i % len(FRAME_MS)] for i in range(len(out))]
    return out, {"frames": len(out), "w": nw, "h": TARGET_H,
                 "durations_ms": durations, "fps": round(1000 / (sum(FRAME_MS) / len(FRAME_MS)), 2),
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
        frames[0].save(clip, save_all=True, append_images=frames[1:],
                       duration=meta["durations_ms"], loop=0, format="WEBP",
                       quality=QUALITY, method=6, exact=True)
        # poster = **인코딩된 클립의 첫 프레임을 그대로 다시 꺼내** 저장한다.
        # ⚠️ 원본 프레임을 따로 인코딩하면 lossy 재인코딩 노이즈로 poster 와 첫 프레임이
        #    미세하게 달라진다(실측 평균 4~5, 최대 54). reduced-motion 으로 전환되는
        #    순간 그 차이가 깜빡임으로 보인다. 같은 인코딩 결과에서 꺼내면 원리적으로 같다.
        # ⚠️ **무손실**로 저장한다. lossy 로 다시 인코딩하면 클립 첫 프레임과 평균 3 정도
        #    어긋나고, reduced-motion 으로 전환되는 순간 그 차이가 깜빡임으로 보인다.
        #    poster 는 reduced-motion 에서만 로드되므로 용량 증가가 상시 비용이 아니다.
        with Image.open(clip) as enc:
            enc.seek(0)
            enc.convert("RGBA").save(poster, format="WEBP", lossless=True, method=6)
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
              f'{meta["clip_kb"]:5d}KB {meta["fps"]}fps '
              f'dur={sorted(set(meta["durations_ms"]))}ms', flush=True)

    payload = {
        "generator": "scripts/assets/build-mascot-motion.py",
        "ssot": "assets/mascot/v1 (2026-08-07 고정, MANIFEST.sha256)",
        "params": {"target_h": TARGET_H, "frame_step": STEP, "quality": QUALITY, "tol": TOL,
                   "frame_ms": list(FRAME_MS), "fps": round(1000 / (sum(FRAME_MS) / len(FRAME_MS)), 2)},
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
