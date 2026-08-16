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

# ⚠️ **일부 SSOT WebP 는 캐릭터가 프레임 밖으로 잘려 있다** (삼순 #1228 ③, 실측).
#    SSOT 13종 중 8종에서 머리가 캔버스 위쪽에 **평평하게** 붙어 있었다
#    (`cheerpom` 상단 202px · `excited` 149px · `cheerC`/`cheer` 112px · `pitching` 109px ·
#     `bored`/`cheerD` 74px · `thinking` 49px — 전 프레임 상단 **연속 불투명 런** 측정).
#
#    원본 생성물(Seedance 2.0 i2v, 1280x720 mp4)을 실측해보니 **6종은 원본이 무결**했다.
#    → 잘림은 생성 결함이 아니라 **이 스크립트의 union-bbox crop 이 만든 파생 결함**이다.
#      원본에서 다시 뽑으면 닫힌다.
#
#    아래 6종만 mp4 원본을 1차 소스로 쓴다. 나머지는 SSOT WebP 를 그대로 쓴다
#    (`cheerpom` 은 SSOT 가 **모자 로고 제거본**이라 mp4 로 되돌리면 로고가 부활한다;
#     `cheerD` 는 mp4 원본도 상단 28px 잘려 있어 원본 교체로 닫히지 않는다 — 둘 다
#     하린아빠 판단 대기 상태이며, 여기서 임의로 바꾸지 않는다).
VIDEO_SRC_ROOT = os.environ.get(
    "MASCOT_VIDEO_SRC", os.path.expanduser("~/.openclaw/workspace/tmp/ref-video"))
VIDEO_SOURCES = {
    "excited": "gen/excited.mp4",
    "cheerC": "gen/cheerC.mp4",
    "bored": "gen/bored.mp4",
    "pitching": "gen/pitching.mp4",
    "thinking": "gen/thinking.mp4",
    "cheer": "gen/cheer.mp4",
}
# crop 안전여백 — union bbox 에 사방으로 이만큼을 더 남긴다(삼순 #1228 ③ 계약).
# 0 이면 캐릭터 실루엣이 캔버스 모서리에 그대로 닿아, 안티에일리어싱 여유조차 없다.
SAFE_PAD = 6
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


def _read_video_frames(path: str):
    """mp4 원본을 디코딩해 RGB 프레임 배열로 돌려준다 (ffmpeg → rawvideo 파이프)."""
    import subprocess
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True)
    w, h = (int(v) for v in probe.stdout.strip().split(",")[:2])
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True)
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    n = buf.size // (w * h * 3)
    return [buf[i * w * h * 3:(i + 1) * w * h * 3].reshape(h, w, 3).astype(np.float32)
            for i in range(n)], (w, h)


def build(name: str):
    video_rel = VIDEO_SOURCES.get(name)
    video_path = os.path.join(VIDEO_SRC_ROOT, video_rel) if video_rel else None
    if video_path and os.path.exists(video_path):
        # 잘리지 않은 원본에서 다시 뽑는다. mp4 는 1280x720 이라 SSOT(480px)보다
        # 프레임당 화소가 7배 많다 — 다운스케일 품질도 함께 좋아진다.
        raw, _ = _read_video_frames(video_path)
        source_kind = f"video:{video_rel}"
        # 원본은 24fps 121프레임. SSOT 경유(STEP=2)와 같은 12fps 로 맞춘다.
        step = 2
    else:
        src = os.path.join(SSOT, f"{name}-black.webp")
        im = Image.open(src)
        raw = []
        for i in range(im.n_frames):
            im.seek(i)
            raw.append(np.asarray(im.convert("RGB")).astype(np.float32))
        source_kind = f"ssot:{name}-black.webp"
        step = STEP
    idx = list(range(0, len(raw), step))
    alphas = [key_frame(raw[i]) for i in idx]

    # union bbox — 전 프레임 합집합으로 잘라야 동작 중 캐릭터가 잘리지 않는다.
    st = np.stack([a > 96 for a in alphas])
    ys, xs = np.where(st.any(axis=0))
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    # ⚠️ **안전여백**. 여백 0 이면 캐릭터가 캔버스 모서리에 그대로 닿아, 원본이 멀쩡해도
    #    파생 자산이 "평평하게 잘린" 것처럼 보인다(삼순 #1228 ③ 의 실제 원인).
    #    캔버스 밖으로는 나갈 수 없으므로 clip 한다 — 원본이 이미 잘린 종은 여기서
    #    여백을 못 얻고, 그 사실은 아래 edge-run 계약 검사로 드러난다.
    H, W = alphas[0].shape
    y0 = max(0, y0 - SAFE_PAD); x0 = max(0, x0 - SAFE_PAD)
    y1 = min(H, y1 + SAFE_PAD); x1 = min(W, x1 + SAFE_PAD)
    bw, bh = x1 - x0, y1 - y0
    nw = max(1, round(bw * TARGET_H / bh))

    out = []
    for k, i in enumerate(idx):
        al = (alphas[k][y0:y1, x0:x1].astype(np.float32) / 255.0)[..., None]
        c = raw[i][y0:y1, x0:x1]
        # 검정 배경 합성본이므로 premultiplied 로 보고 un-premultiply → 검정 fringe 제거.
        est = np.clip(np.where(al > 0.02, c / np.maximum(al, 0.02), c), 0, 255)
        rgba = np.concatenate([est, al * 255], axis=2).astype(np.uint8)
        small = np.asarray(Image.fromarray(rgba).resize((nw, TARGET_H), Image.LANCZOS))
        # ⚠️ **완전투명 픽셀의 RGB 를 0 으로 지운다** — 반드시 **리사이즈 뒤에** (삼순 P0-②).
        #    ① un-premultiply 는 alpha 로 나누므로 alpha≈0 인 곳의 RGB 에 원본 배경색
        #       (검정/남색)이 그대로 남는다.
        #    ② LANCZOS 는 이웃 색을 섞으므로, 리사이즈 **전에** 지워도 유니폼 남색이
        #       투명 영역으로 다시 번진다(실측: 지우고 재빌드했는데 swing 투명 영역에
        #       (11,11,68) 7,486px 이 그대로 남았다 — 순서가 틀렸던 것).
        #    화면에는 안 보이지만 **알파를 무시하고 RGB 만 읽는 도구**(raw 뷰어·썸네일러·
        #    일부 이미지 파이프라인)에서는 "큰 남색 직사각형"으로 보인다 — 삼순이 실제로
        #    그렇게 관측했다. 안 보인다고 쓰레기를 남기면 다른 소비 경로에서 그대로 터진다.
        #    (`exact=True` 로 저장하므로 이 0 이 인코딩에서도 보존된다.)
        small = small.copy()
        small[..., :3][small[..., 3] == 0] = 0
        # ⚠️ Pillow WebP 인코더는 **연속된 동일 프레임을 합치고 duration 을 더한다.**
        #    그러면 83+84=167ms 프레임이 생겨 "전 프레임 12fps" 계약이 깨진다
        #    (실측: pitching·thinking·cheerD 각 1프레임). 원본 정지 구간에서 발생한다.
        #    ⚠️ **RGB 만 흔들면 소용없다** — alpha=0 픽셀의 RGB 는 lossy 인코딩이 평탄화해
        #       병합이 되살아난다. WebP 는 **alpha 를 무손실로** 저장하므로 alpha 를 흔든다.
        #       alpha 1~3/255 ≈ 0.4~1.2% + RGB 0 → 화면에서는 보이지 않는다.
        #    (numpy 단계에서 넣는다 — `Image.fromarray` 결과는 readonly 라 `load()` 로
        #     쓰면 `ValueError: image is readonly` 가 난다. 실측으로 빌드가 죽었다.)
        small[0, 0] = (0, 0, 0, 1 + (k % 3))
        out.append(Image.fromarray(small))

    # 프레임별 duration — 83/84 교대. Pillow 는 리스트를 받아 프레임마다 적용한다.
    durations = [FRAME_MS[i % len(FRAME_MS)] for i in range(len(out))]
    return out, {"frames": len(out), "w": nw, "h": TARGET_H,
                 "durations_ms": durations, "fps": round(1000 / (sum(FRAME_MS) / len(FRAME_MS)), 2),
                 "source_frames": len(raw), "source": source_kind}


def max_edge_run(alpha: np.ndarray) -> dict:
    """네 변에서 **연속 불투명 런**의 최댓값. 이게 0 이 아니면 캐릭터가 잘린 것이다.

    단순 "모서리에 불투명 픽셀이 있나"로는 부족하다 — 안티에일리어싱 1~2px 접촉과
    머리가 평평하게 잘린 것은 **연속 길이**로만 구분된다(실측으로 확정).
    """
    def run(line):
        best = cur = 0
        for v in line:
            cur = cur + 1 if v >= 250 else 0
            best = max(best, cur)
        return best
    return {"top": run(alpha[0]), "bottom": run(alpha[-1]),
            "left": run(alpha[:, 0]), "right": run(alpha[:, -1])}


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

    report, mismatched, clipped = {}, [], []
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
            first = np.asarray(enc.convert("RGBA")).copy()
        # ⚠️ poster 는 **lossy 로 인코딩된 클립을 디코딩해서** 뽑는다. 그 디코딩 결과의
        #    투명 영역 RGB 에는 인코더가 번지게 한 배경색이 남아 있고, 무손실로 저장하면
        #    그 쓰레기까지 **그대로 보존**된다(실측: swing-poster 투명 영역에 (11,11,68)
        #    7,486px). 클립 프레임을 정리해도 poster 는 별도 경로라 따로 지워야 한다.
        first[..., :3][first[..., 3] == 0] = 0
        # ⚠️ `exact=True` 필수. libwebp 는 기본적으로 **투명 픽셀의 RGB 를 압축이 잘 되는
        #    값으로 마음대로 바꾼다**(무손실 모드에서도). 그래서 위에서 0 으로 지워도
        #    저장 과정에서 다시 채워진다(실측: thinking-poster 투명영역 88.7% 가 비검정).
        #    클립 저장에는 이미 exact=True 가 있었는데 poster 만 빠져 있었다.
        Image.fromarray(first).save(poster, format="WEBP", lossless=True, method=6, exact=True)
        # ── 잘림 계약 검사 (삼순 #1228 ③) ──────────────────────────────────
        # **전 프레임 + poster** 를 디코딩해 네 변의 연속 불투명 런을 잰다.
        # union bbox + SAFE_PAD 로 만들어도, 원본 자체가 잘린 종은 여기서 드러난다.
        runs = {"top": 0, "bottom": 0, "left": 0, "right": 0}
        worst_frame = -1
        with Image.open(clip) as enc:
            for fi in range(enc.n_frames):
                enc.seek(fi)
                a = np.asarray(enc.convert("RGBA"))[..., 3]
                r = max_edge_run(a)
                if max(r.values()) > max(runs.values()):
                    worst_frame = fi
                runs = {k: max(runs[k], r[k]) for k in runs}
        with Image.open(poster) as pim:
            pr = max_edge_run(np.asarray(pim.convert("RGBA"))[..., 3])
        runs = {k: max(runs[k], pr[k]) for k in runs}
        meta["edge_run"] = runs
        meta["edge_run_worst_frame"] = worst_frame
        if max(runs.values()) > 0:
            clipped.append((n, runs, worst_frame))
        meta["clip_sha256"] = sha256(clip)
        meta["poster_sha256"] = sha256(poster)
        meta["clip_kb"] = round(os.path.getsize(clip) / 1024)
        report[n] = meta
        if args.check:
            for kind, built in (("clip", clip), ("poster", poster)):
                shipped = os.path.join(outdir, os.path.basename(built))
                if not os.path.exists(shipped) or sha256(shipped) != sha256(built):
                    mismatched.append(os.path.basename(built))
        er = meta["edge_run"]
        mark = "✅" if max(er.values()) == 0 else f'🔴잘림 {max(er.values())}px'
        print(f'{n:12s} {meta["frames"]:3d}f {meta["w"]:3d}x{meta["h"]} '
              f'{meta["clip_kb"]:5d}KB {meta["fps"]}fps '
              f'[{meta["source"].split(":")[0]}] {mark}', flush=True)

    payload = {
        "generator": "scripts/assets/build-mascot-motion.py",
        "ssot": "assets/mascot/v1 (2026-08-07 고정, MANIFEST.sha256)",
        "params": {"target_h": TARGET_H, "frame_step": STEP, "quality": QUALITY, "tol": TOL,
                   "safe_pad": SAFE_PAD,
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
