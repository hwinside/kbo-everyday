#!/usr/bin/env python3
"""마스코트 **원본 mp4** 에 결함을 주입해 임시 소스 트리를 만든다 (삼순 2026-08-17 P0).

왜 필요한가
-----------
`overfill_px` / `dropped_persist_frames` 는 **빌더가 원본 픽셀과 대조해** 재는 값이라,
최종 WebP 를 아무리 훼손해도 그 축은 움직이지 않는다. 최종 자산만 변이하는 mutation 은
"과채움·소품삭제 게이트가 결함을 잡는다"를 전혀 증명하지 못한다 — 삼순 지적.

그래서 여기서는 **빌더 입력**을 바꾼다:

  add-prop   캐릭터와 **떨어진** 작은 단색 사각형을 전 프레임에 그린다.
             speck 제거가 이걸 지우고, 지속 프레임이 쌓여 `[B-DROP]` 이 떠야 한다.
             (크기는 최대 조각의 speck_frac 미만이어야 '지워지는' 대상이 된다.)

  seal-gap   다리 사이·팔과 몸 사이 같은 **정상 음공간의 입구만** 막아 가둔다.
             그러면 `binary_fill_holes` 가 그 안을 메우고, 그 픽셀은 원본에서
             **진짜 배경**이었으므로 `[B-OVERFILL]` 이 뜼다.

             🔴 단순히 몸 안쪽을 배경색으로 칠하는 방식은 **원리적으로 안 된다**(실측).
             빌더의 전경은 "프레임 바깥에 연결된 배경"의 여집합이라, 몸 안에 갇힌
             배경은 그 자체로 이미 전경으로 분류된다 — 메울 구멍이 애초에 안 생긴다.
             (excited 에 40x40 구멍도, 도넘 링 + 섬도 둘 다 overfill 0 이었다.)
             과채움은 **바깥과 이어져 있던 음공간이 닫힐 때**만 생긴다.

사용:
  python3 scripts/qa/mascot-source-mutate.py --clip cheerstick --mode add-prop \
      --src ~/.openclaw/workspace/assets/mascot --out /tmp/mut-src
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys

import numpy as np
from scipy import ndimage

REL = "v2-regen/{clip}.mp4"


def read_frames(path: str) -> tuple[np.ndarray, float]:
    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,r_frame_rate", "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True).stdout.strip().split(",")
    w, h = int(probe[0]), int(probe[1])
    num, den = probe[2].split("/")
    fps = float(num) / float(den)
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", path, "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
        capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3).copy(), fps


def write_frames(frames: np.ndarray, fps: float, path: str) -> None:
    n, h, w, _ = frames.shape
    os.makedirs(os.path.dirname(path), exist_ok=True)
    proc = subprocess.Popen(
        ["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
         "-s", f"{w}x{h}", "-r", f"{fps}", "-i", "-",
         # 무손실에 가깝게 — 재인코딩 노이즈가 판정을 흔들면 결함주입이 아니라 노이즈 실험이 된다.
         "-c:v", "libx264", "-qp", "0", "-pix_fmt", "yuv444p", path],
        stdin=subprocess.PIPE)
    proc.communicate(frames.tobytes())
    if proc.returncode != 0:
        raise SystemExit(f"ffmpeg 인코딩 실패: {path}")


def bg_color(frame: np.ndarray) -> np.ndarray:
    h, w, _ = frame.shape
    corners = np.array([frame[2, 2], frame[2, w - 3], frame[h - 3, 2], frame[h - 3, w - 3]],
                       dtype=np.int16)
    return np.median(corners, axis=0)


def foreground(frame: np.ndarray, tol: int) -> np.ndarray:
    """빌더와 같은 방식(외곽 연결 flood-fill)으로 전경 마스크를 만든다."""
    a = frame.astype(np.int16)
    lab, _ = ndimage.label(np.abs(a - bg_color(frame)).max(axis=2) <= tol)
    edge = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    return ~np.isin(lab, list(edge))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--clip", required=True)
    ap.add_argument("--mode", required=True, choices=["add-prop", "seal-gap"])
    ap.add_argument("--src", required=True, help="원본 루트(v2-regen 의 부모)")
    ap.add_argument("--out", required=True, help="변이본을 쓸 루트")
    ap.add_argument("--tol", type=int, default=8)
    args = ap.parse_args()

    src = os.path.join(os.path.expanduser(args.src), REL.format(clip=args.clip))
    dst = os.path.join(os.path.expanduser(args.out), REL.format(clip=args.clip))
    frames, fps = read_frames(src)
    n, h, w, _ = frames.shape
    fg0 = foreground(frames[0], args.tol)
    comp, ncomp = ndimage.label(fg0)
    sizes = ndimage.sum(fg0, comp, range(1, ncomp + 1))
    body_px = int(sizes.max()) if ncomp else 0

    if args.mode == "add-prop":
        # speck 제거 대상이 되려면 **최대 조각의 0.5% 미만**이어야 한다.
        side = max(8, int((body_px * 0.004) ** 0.5))
        ys, xs = np.nonzero(fg0)
        # 캐릭터와 확실히 떨어진 위치 — 좌상단 여백.
        y0 = max(4, int(ys.min()) - side - 40)
        x0 = max(4, int(xs.min()) - side - 40)
        if y0 < 4 or x0 < 4:
            y0, x0 = 8, 8
        # 배경과 색거리가 확실히 먼 단색(=진짜 물체로 보이는 조각).
        col = np.array([255, 40, 40], dtype=np.uint8)
        frames[:, y0:y0 + side, x0:x0 + side] = col
        print(f"add-prop: {side}x{side} @({x0},{y0}) · body={body_px}px "
              f"· speck 한계={body_px * 0.005:.0f}px · 조각={side * side}px", flush=True)
    else:
        # 음공간(오목)을 찾아 **입구만** 막는다.
        #   pocket = closing(body) - body  → 다리 사이·팔과 몸 사이의 오목
        #   lid    = pocket 의 바깥쪽 테두리  → 여기만 몸 색으로 칠한다
        #   core   = 남은 안쪽  → 이젠 몸∪lid 에 둘러싸여 fill_holes 가 메운다
        # core 는 원본에서 진짜 배경이므로 그대로 overfill 이 된다.
        body = comp == (int(np.argmax(sizes)) + 1)
        is_bg0 = np.abs(frames[0].astype(np.int16) - bg_color(frames[0])).max(axis=2) <= args.tol
        sealed = None
        for k in (25, 33, 41, 17):
            pocket = ndimage.binary_closing(body, np.ones((k, k))) & ~body & is_bg0
            if not pocket.any():
                continue
            core = ndimage.binary_erosion(pocket, np.ones((5, 5)))
            lid = pocket & ~core
            if core.sum() >= 60 and lid.any():
                sealed = (k, pocket, core, lid)
                break
        if sealed is None:
            raise SystemExit("봉할 음공간을 못 찾았다")
        k, pocket, core, lid = sealed
        # 몸 색 하나를 가져다 lid 에 칠한다(배경과 확실히 먼 색).
        by, bx = np.nonzero(body)
        paint = frames[0][by[len(by) // 2], bx[len(bx) // 2]].copy()
        if np.abs(paint.astype(np.int16) - bg_color(frames[0])).max() <= args.tol * 3:
            paint = np.array([255, 40, 40], dtype=np.uint8)
        frames[:, lid] = paint
        print(f"seal-gap: closing k={k} · pocket={int(pocket.sum())}px "
              f"· lid={int(lid.sum())}px → 갇힐 core={int(core.sum())}px "
              f"(이게 그대로 과채움이 된다) · 칠한 색 {tuple(int(v) for v in paint)}",
              flush=True)

    write_frames(frames, fps, dst)
    print(f"→ {dst} ({n}f {w}x{h})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
