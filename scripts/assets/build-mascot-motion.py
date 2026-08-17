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
#
#    🔴 그런데 원본 mp4 도 **전 프레임 전수**로 재보니 무결한 것은 3종뿐이었다
#       (`bored`·`thinking`·`cheer`). 7프레임 샘플로는 무결해 보였는데, 잘린 프레임이
#       동작 중 한순간(1~18프레임)에만 나타나 샘플에 안 걸린 것이었다.
#       → **분모를 잘라놓고 전체라고 말하지 않는다.**
#
#    그래서 하린아빠 승인(2026-08-17 01:24 "재생성")을 받아 잘린 종을 Seedance 2.0 i2v 로
#    **재생성**했다(`assets/mascot/v2-regen/*.mp4`). 재생성 계약 2가지가 핵심이다:
#      ① **시작 이미지에 여백을 만든다** — 깨끗한 프레임에서 캐릭터를 떼어 캔버스의
#         38~55% 크기로 줄이고 사방 여백을 준 레퍼런스를 쓴다. 기존 원본은 캐릭터가
#         프레임을 꽉 채워서 팔만 올려도 잘렸다.
#      ② **프롬프트에 잘림 금지를 명시** — "never touches or crosses the edge" +
#         고정 카메라·스케일 유지. `pitching` 은 이래도 3회 잘려(좌측 276px) 동작 자체를
#         "팔꿈치만 움직이는 작은 동작"으로 축소해서야 통과했다.
#    전 재생성본은 아래 edge-run 계약을 **전 프레임 전수**로 통과했다(실측 여백 107~214px).
VIDEO_SRC_ROOT = os.environ.get(
    "MASCOT_VIDEO_SRC", os.path.expanduser("~/.openclaw/workspace/assets/mascot"))
# 13종 **전부** 이 폴더의 mp4 에서 뽑는다. SSOT WebP 경유 경로는 더 이상 쓰지 않는다
# (그 경로가 잘림의 원인이었고, 종별로 소스가 갈리면 어느 자산이 어디서 왔는지 추적이 안 된다).
#   · 9종 = 2026-08-17 재생성본(잘림 0 실측)
#   · 4종 = 원본 mp4 가 전수 무결이라 그대로 복사(bored·thinking·cheerG·headspin)
VIDEO_SOURCES = {n: f"v2-regen/{n}.mp4" for n in (
    "bored", "cheer", "cheerC", "cheerD", "cheerG", "cheerpom", "cheerstick",
    "cheertowel", "excited", "headspin", "pitching", "swing", "thinking",
)}
# crop 안전여백 — union bbox 에 사방으로 이만큼을 더 남긴다(삼순 #1228 ③ 계약).
# 0 이면 캐릭터 실루엣이 캔버스 모서리에 그대로 닿아, 안티에일리어싱 여유조차 없다.
SAFE_PAD = 6
OUT = os.path.join(os.path.dirname(__file__), "..", "..", "public", "mascot", "motion")
MANIFEST = os.path.join(OUT, "DERIVED.json")
# 원본 mp4 해시 대장 — **repo 안**에 산다. 원본 바이너리는 repo 밖(22MB)에 있어서,
# 어떤 원본으로 빌드됐는지를 repo 만 보고도 판정할 수 있게 하는 것이 목적이다.
SRC_LEDGER = os.path.join(os.path.dirname(__file__), "mascot-motion-SOURCES.sha256")

# 배경 색 허용 오차.
# 🔴 종전 26 은 **너무 넓었다**(삼순 #1228 P0-①, 실측으로 확정).
#    생성 원본의 배경은 완전 평탄한 단색이다(실측: 남색 32,43,70 / 검정 0,0,0 / 회색 46,46,46)
#    — 그런데 마스코트의 **모자·유니폼도 남색**이라, 26 이면 배경과의 색거리가 26 안에 들어오는
#    유니폼 픽셀이 배경과 **연결**돼 flood-fill 이 몸통을 바깥에서부터 파먹는다.
#    실측(cheerC f34 원본): tol26 = 60,712px vs tol6 = 79,234px — **23% 가 사라졌다.**
#
#    이게 왜 종전 게이트를 다 통과했나:
#      · 파먹힌 영역은 **바깥과 연결**돼 있으므로 원본 해상도에서는 '내부 구멍'이 아니다(hole=0).
#      · 다운스케일(LANCZOS)에서 가느다란 연결 다리가 끊기면서 **그제서야 내부 구멍이 된다**
#        (실측: 원본 hole 0 → 192px 파생 hole 509px).
#      · edge-run 은 모서리만 보므로 몸통 한가운데가 뚫려도 0 이다.
#    → 숫자 3개(edge-run·채움률·bbox)가 전부 GREEN 인데 화면은 속이 빈 마스코트였다.
TOL = 8
TARGET_H = 192    # 2x 자산 (렌더 96px)
STEP = 2          # 24fps → 12fps
QUALITY = 62
# 12fps = 83.33ms/frame. 정수만 쓸 수 있어 83/84 를 번갈아 넣어 평균을 맞춘다.
FRAME_MS = (83, 84)


# 전경 조각 중 **가장 큰 조각의 이 비율 미만**은 키잉 잡티로 보고 버린다.
# 배경의 압축 노이즈가 섬처럼 남으면 파생 자산에 점이 찍힌다(실측: thinking 365px).
SPECK_FRAC = 0.005

# 내부 구멍 허용치(px) — 다운스케일 경계에서 1~2px 짜리는 불가피하다.
HOLE_PX_MAX = 8
# 실루에 변화량 하한(%) — "활발하게 움직이는" 요구사항을 숫자로 고정한 것.
MOTION_PCT_MIN = 1.2

# 🔴 **역방향** 계약 (삼순 2026-08-17). 결함을 지우는 보정이 정상 요소까지 지우면
# 그것도 똑같은 화면 결함이다. 둘 다 원본 대조로 재기 때문에 임의 임계값이 아니다.
#   · overfill  = fill_holes 가 원본의 진짜 배경(다리 사이 등)을 메운 양 — 실측 13종 전부 0.
#   · dropped   = speck 제거로 사라진 조각이 **진짜 소품이었는가**.
#
# 🔴 처음엔 `dropped <= 500px` 로 둔었는데 그건 **임의 통과선**이었다(삼순 지적).
#    크기로는 가를 수 없다 — 실측에서 노이즈가 411px 까지 커졌고, 색거리도 못 가른다
#    (bored 노이즈는 순백색 dist 255, thinking 은 dist 8 의 엷은 그림자).
#    가르는 것은 **지속성**이다. 진짜 소품(공·응원도구)은 연속 프레임에 계속 있고,
#    생성모델의 압축 아티팩트는 한→두 프레임 반짝이고 사라진다.
#    실측(색이 뚜렷한 30px+ 조각의 최대 연속 프레임): bored 4 · cheer 1 · 나머지 11종 0.
#    기준 6프레임은 12fps 에서 **0.5초** — 사람이 "물체가 있다"고 인지하는 최소 노출시간이며,
#    통과시키려고 고른 값이 아니다(현재 최대값 4 와 기준 6 은 같은 자리에서 나오지 않았다).
OVERFILL_PX_MAX = 0
DROPPED_MIN_PX = 30          # 이보다 작은 조각은 애초에 물체로 안 보인다
DROPPED_SOLID_DIST = TOL * 3  # 이보다 배경색에서 멀면 '배경 노이즈'가 아니라 진한 물체
DROPPED_PERSIST_MAX = 5       # 연속 6프레임(0.5초) 이상 지속하면 소품이다 → FAIL


def key_frame(rgb: np.ndarray) -> np.ndarray:
    """flood-fill 키잉 — 네 모서리 색과 **외곽에 연결된** 영역만 배경으로 본다.

    단순 색 거리 판정이면 캐릭터 안쪽의 같은 색 픽셀(모자·유니폼 그림자)까지
    뚫려서 구멍이 난다. 연결성을 봐야 안쪽이 살아남는다.

    연결성만으로는 부족하다는 것이 삼순 #1228 P0-① 로 드러났다. 배경과 **색이 가까운**
    유니폼을 타고 flood-fill 이 몸 안으로 걸어 들어오면 그 경로 전체가 바깥과
    연결돼 버려서, 그 순간에는 '구멍'으로 보이지도 않는다. 그래서 세 겹으로 막는다:
      ① TOL 을 8 로 좁혀 애초에 유니폼을 배경으로 오인하지 않는다(위 상수 주석 참조).
      ② `binary_fill_holes` — 전경으로 **둘러싸인** 배경 조각은 몸의 일부로 되돌린다.
         정상적인 틈(다리 사이·들어올린 팔과 몸통 사이)은 바깥과 이어져 있으므로
         메워지지 않는다(실측으로 확인).
      ③ 큰 조각 대비 0.5% 미만의 부유 조각은 버린다 — 배경 압축 노이즈 제거.
    """
    al, _ = key_frame_audit(rgb)
    # 경계 1px 을 부드럽게 — 계단현상 제거. 배경 쪽은 0.55 로 눌러 halo 를 줄인다.
    af = ndimage.uniform_filter(al.astype(np.float32), size=3)
    return np.where(al > 0, np.maximum(al, af), af * 0.55).clip(0, 255).astype(np.uint8)


def key_frame_audit(rgb: np.ndarray):
    """`key_frame` 의 하드 알파 + **그 과정에서 무엇을 지우고 메웠는지**를 함께 돌려준다.

    🔴 삼순 2026-08-17 — **역방향 false-green**. 위 ②③(fill_holes·speck 제거)는 결함을
    지우는 도구인 동시에 **정상 요소를 지우는 도구**다. 한 방향(원본 전경 소실=0)만
    재면 그 부작용이 그대로 통과한다. 그래서 두 수치를 같이 내보낸다:
      · `overfill` = fill_holes 가 **원본에서 진짜 배경**이었던 곳을 메운 픽셀 수.
                     다리 사이 같은 정상 음공간을 메우면 여기 걸린다.
      · `dropped`  = speck 제거로 사라진 분리 조각 중 **최대 조각** 크기.
                     공·응원도구 같은 의미 있는 작은 요소가 지워졌는지를 본다.
    둘 다 임의 임계값이 아니라 **원본 픽셀 대조**로 잰다.
    """
    a = rgb.astype(np.int16)
    h, w, _ = a.shape
    bgc = np.median(np.array([a[2, 2], a[2, w - 3], a[h - 3, 2], a[h - 3, w - 3]]), axis=0)
    is_bg = np.abs(a - bgc).max(axis=2) <= TOL
    lab, _ = ndimage.label(is_bg)
    edge = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    edge.discard(0)
    raw_fg = ~np.isin(lab, list(edge))

    comp, ncomp = ndimage.label(raw_fg)
    kept, dropped_px, solid_drop = raw_fg, 0, 0
    if ncomp > 1:
        sizes = ndimage.sum(raw_fg, comp, range(1, ncomp + 1))
        keep = [i + 1 for i, s in enumerate(sizes) if s >= sizes.max() * SPECK_FRAC]
        kept = np.isin(comp, keep)
        gone = raw_fg & ~kept
        if gone.any():
            dist = np.abs(a - bgc).max(axis=2)
            gl, gn = ndimage.label(gone)
            for c in range(1, gn + 1):
                m = gl == c
                px = int(m.sum())
                dropped_px = max(dropped_px, px)
                # 크고(물체로 보일 만하고) 색이 배경과 뚜렷한 조각만 '소품 후보'다.
                if px >= DROPPED_MIN_PX and dist[m].max() > DROPPED_SOLID_DIST:
                    solid_drop = max(solid_drop, px)

    fg = ndimage.binary_fill_holes(kept)
    # 메운 자리 중 원본에서 **진짜 배경색**이었던 픽셀만 과채움으로 센다.
    overfill_px = int(((fg & ~kept) & is_bg).sum())
    return fg.astype(np.uint8) * 255, {"overfill": overfill_px, "dropped": dropped_px,
                                       "solid_drop": solid_drop}


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
    alphas, audits = [], []
    for i in idx:
        hard, au = key_frame_audit(raw[i])
        soft = ndimage.uniform_filter(hard.astype(np.float32), size=3)
        alphas.append(np.where(hard > 0, np.maximum(hard, soft), soft * 0.55)
                      .clip(0, 255).astype(np.uint8))
        audits.append(au)
    overfill_px = max(a["overfill"] for a in audits)
    dropped_px = max(a["dropped"] for a in audits)
    # 색이 뚜렷한 조각이 **몇 프레임 연속**으로 사라졌는가 — 소품이면 이어진다.
    persist = best = 0
    for au in audits:
        persist = persist + 1 if au["solid_drop"] > 0 else 0
        best = max(best, persist)
    dropped_persist = best

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

    # 원본 배경색 — 키잉 결함 판정에 쓴다(아래 `keying_defect_px`). 첫 프레임 네 모서리.
    _f0 = raw[0].astype(np.int16)
    _h0, _w0, _ = _f0.shape
    src_bgc = np.median(np.array([_f0[2, 2], _f0[2, _w0 - 3],
                                  _f0[_h0 - 3, 2], _f0[_h0 - 3, _w0 - 3]]), axis=0)

    out, src_small = [], []
    for k, i in enumerate(idx):
        al = (alphas[k][y0:y1, x0:x1].astype(np.float32) / 255.0)[..., None]
        c = raw[i][y0:y1, x0:x1]
        # 키잉 **전** 원본을 파생 해상도로 줄여 같이 들고 간다 — 구멍이 키잉 결함인지
        # 정상 음공간인지는 원본 색을 봐야만 갈린다(임의 임계값으로 가르면 false-green).
        src_small.append(np.asarray(
            Image.fromarray(c.astype(np.uint8)).resize((nw, TARGET_H), Image.NEAREST)))
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
                 "source_frames": len(raw), "source": source_kind,
                 "overfill_px": overfill_px, "dropped_component_px": dropped_px,
                 "dropped_persist_frames": dropped_persist,
                 "src_frames": src_small, "src_bgc": src_bgc}


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


def _enclosed(mask: np.ndarray) -> np.ndarray:
    """`mask`(불투명) 기준으로 **바깥과 연결되지 않은** 투명 영역."""
    lab, _ = ndimage.label(~mask)
    border = set(lab[0, :]) | set(lab[-1, :]) | set(lab[:, 0]) | set(lab[:, -1])
    border.discard(0)
    return (lab > 0) & (~np.isin(lab, list(border)))


def enclosed_hole_px(alpha: np.ndarray) -> int:
    """몸 안의 구멍 픽셀 수 — **두 임계값에서 동시에** 닫힌 영역만 센다.

    edge-run 은 캔버스 **변**만 본다. 몸통 한가운데가 뚫려도 0 이다
    (삼순 2026-08-17 P0-①: cheerC 509px · cheertowel 127px 이 edge-run 0 으로 통과했다).

    ⚠️ 단일 임계값은 경계가 반투명인 곳에서 흔든다. alpha>128 만 보면 진한
    안티에일리싱 띄가 버팔처럼 작용해 정상 틈을 구멍으로 오보하고, alpha>24 만
    보면 엷은 구멍을 놓친다. 둘 다에서 닫힌 영역만 구멍으로 본다.
    """
    return int((_enclosed(alpha > 128) & _enclosed(alpha > 24)).sum())


def keying_defect_px(alpha: np.ndarray, src_rgb: np.ndarray, bgc: np.ndarray) -> int:
    """닫힌 투명 영역 중 **원본에서 배경이 아니었던** 픽셀 수 = 키잉이 몸을 먹은 양.

    🔴 이게 이 파일의 핵심 판별자다. "닫힌 투명 영역"은 두 가지가 섞여 있다:
      · **정상 음공간** — 두 다리 사이처럼 발끝이 붙어 닫힐 수 있다. 원본에서도 거기는
        진짜 배경이다(실측: `excited` 다리 사이 117px).
      · **키잉 결함** — 배경과 색이 가까운 유니폼을 배경으로 오인해 몸을 파먹은 경우.
        원본에서 그 자리는 **배경색이 아니다**(실측: 수정 전 `cheerC` 321px).
    숫자 크기로는 둘을 가를 수 없고(37~509px 가 섞인다), 임의 임계값을 고르면 그게
    바로 "통과시키려고 고른 값"이 된다. 그래서 **원본 픽셀을 직접 본다.**
    """
    holes = _enclosed(alpha > 128) & _enclosed(alpha > 24)
    if not holes.any():
        return 0
    # 파생 좌표 → 원본 좌표 (동일 비율 축소만 있으므로 매핑은 단순 스케일)
    h, w = holes.shape
    sh, sw, _ = src_rgb.shape
    ys, xs = np.nonzero(holes)
    sy = np.clip((ys * sh // h), 0, sh - 1)
    sx = np.clip((xs * sw // w), 0, sw - 1)
    px = src_rgb[sy, sx].astype(np.int16)
    # 원본에서 배경색과 멀면 → 거기에 몸이 있었다 → 키잉이 먹은 것.
    return int((np.abs(px - bgc).max(axis=1) > TOL * 2).sum())


def silhouette_motion_pct(masks) -> float:
    """인접 프레임 실루에 IoU 거리의 평균(%) — **정말 움직이는가**.

    잘림을 피하려고 동작을 줄이면 수치 계약은 전부 통과하면서 화면은 호흡 idle 이 된다
    (삼순 2026-08-17 P0-① `pitching` 0.48%). 그러니 움직임도 계약으로 재는다.
    """
    if len(masks) < 2:
        return 0.0
    tot = 0.0
    for i in range(1, len(masks)):
        inter = np.logical_and(masks[i], masks[i - 1]).sum()
        union = np.logical_or(masks[i], masks[i - 1]).sum()
        tot += 1 - inter / union if union else 0.0
    return round(tot / (len(masks) - 1) * 100, 2)


def sha256(path: str) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="재현 검사만(쓰기 없음)")
    ap.add_argument("--rewrite-ledger", action="store_true",
                    help="원본 mp4 해시 대장을 현재 파일 기준으로 갱신(의도한 교체일 때만)")
    args = ap.parse_args()


    # 🔴 대상 목록은 **`VIDEO_SOURCES` 가 SSOT** 다 (삼순 2026-08-17).
    #    종전엔 v1 폴더의 `*-black.webp` 목록에서 파생시켰는데, 이젠 전 종을 mp4 에서
    #    뽑으므로 v1 은 더 이상 입력이 아니다. v1 에 파일을 하나 더 넣거나 빼면
    #    빌드 대상이 조용히 바뀜는 경로였다.
    names = sorted(VIDEO_SOURCES)
    if not names:
        print("VIDEO_SOURCES 가 비어 있다 — 빌드할 대상이 없다.", file=sys.stderr)
        return 2

    # 🔴 **원본 mp4 가 없으면 조용히 v1 SSOT 로 fallback 하지 않고 죽는다** (삼순 2026-08-17 P1).
    #    종전에는 `os.path.exists` 가 False 면 조용히 구 SSOT 로 넘어갔다. 그러면 manifest 는
    #    "v2 원본에서 뽑았다"고 적혀 있는데 실제 자산은 구본이 되는 — 가장 나쁜 종류의
    #    조용한 실패다. 여기서 멈추면 "왜 안 돼요"가 바로 보인다.
    missing = [f"{n} ← {os.path.join(VIDEO_SRC_ROOT, rel)}"
               for n, rel in sorted(VIDEO_SOURCES.items())
               if not os.path.exists(os.path.join(VIDEO_SRC_ROOT, rel))]
    if missing:
        print(f"❌ 원본 mp4 {len(missing)}개 없음 — 구 SSOT 로 fallback 하지 않고 중단한다:",
              file=sys.stderr)
        for m in missing:
            print(f"   · {m}", file=sys.stderr)
        print("  → MASCOT_VIDEO_SRC 로 원본 폴더를 지정하세요(v2-regen 포함).", file=sys.stderr)
        return 2

    # 🔴 원본이 있기만 하면 되는 게 아니라 **그 원본이여야** 한다 (삼순 2026-08-17 P1).
    #    원본은 repo 밖(13종 22MB, v1 SSOT 와 같은 방식)에 산다. 그러면 "어떤 파일을
    #    썼는가"를 repo 만 보고는 알 수 없으므로, **sha256 대장을 repo 에 둘다**
    #    (`SOURCES.sha256`). 해시가 바뀜 상태로 빌드하면 멈춘다 — "원본을 조용히 바꿔놓고
    #    같은 자산이라고 말하는" 경로를 닫는다.
    src_hashes = {n: sha256(os.path.join(VIDEO_SRC_ROOT, rel))
                  for n, rel in sorted(VIDEO_SOURCES.items())}
    # 🔴 대장이 **없으면** 검사를 건너뛰던 것도 false-green 이다 (삼순 2026-08-17).
    #    대장을 지우면 `--check` 가 그냥 통과해버렸다. 검증 모드에선 대장을 **필수**로 둔다
    #    (최초 생성은 빌드 모드에서만 허용).
    if args.check and not os.path.exists(SRC_LEDGER):
        print(f"❌ 원본 해시 대장이 없다: {os.path.relpath(SRC_LEDGER)}", file=sys.stderr)
        print("  → 대장 없이는 '어떤 원본으로 만들었는지'를 증명할 수 없으므로 검증을 통과시키지 않는다.",
              file=sys.stderr)
        return 2
    if os.path.exists(SRC_LEDGER):
        with open(SRC_LEDGER, encoding="utf-8") as fh:
            recorded = dict(
                (ln.split("  ", 1)[1].strip(), ln.split("  ", 1)[0].strip())
                for ln in fh if "  " in ln and not ln.startswith("#"))
        drift = [f'{n}: 대장={recorded.get(VIDEO_SOURCES[n], "없음")[:12]} 실제={h[:12]}'
                 for n, h in src_hashes.items()
                 if recorded.get(VIDEO_SOURCES[n]) != h]
        if drift and not args.rewrite_ledger:
            print(f"❌ 원본 mp4 해시가 대장과 다르다({len(drift)}건) — 중단:", file=sys.stderr)
            for d in drift:
                print(f"   · {d}", file=sys.stderr)
            print(f"  → 의도한 교체라면 --rewrite-ledger 로 대장을 갱신하고 근거를 남기세요"
                  f" ({os.path.relpath(SRC_LEDGER)}).", file=sys.stderr)
            return 2

    outdir = os.path.abspath(OUT)
    tmpdir = outdir if not args.check else os.path.join("/tmp", "mascot-motion-check")
    os.makedirs(tmpdir, exist_ok=True)

    report, mismatched, clipped, defective = {}, [], [], []
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
        hole_px, hole_frame, masks = 0, -1, []
        defect_px, defect_frame = 0, -1
        with Image.open(clip) as enc:
            for fi in range(enc.n_frames):
                enc.seek(fi)
                a = np.asarray(enc.convert("RGBA"))[..., 3]
                r = max_edge_run(a)
                if max(r.values()) > max(runs.values()):
                    worst_frame = fi
                runs = {k: max(runs[k], r[k]) for k in runs}
                # 내부 구멍·움직임도 **같은 디코딩 루프**에서 재다. 게이트가 별도로 재구현하면
                # 생성기와 조용히 어긋난다(8/15 교훈) — 생성기가 적고 게이트가 대조한다.
                h = enclosed_hole_px(a)
                if h > hole_px:
                    hole_px, hole_frame = h, fi
                if h > 0:
                    # 구멍이 있는 프레임만 원본과 대조한다(전부 대조하면 느리다).
                    src = meta["src_frames"][fi]
                    d = keying_defect_px(a, src, meta["src_bgc"])
                    if d > defect_px:
                        defect_px, defect_frame = d, fi
                masks.append(a > 128)
        with Image.open(poster) as pim:
            pr = max_edge_run(np.asarray(pim.convert("RGBA"))[..., 3])
        runs = {k: max(runs[k], pr[k]) for k in runs}
        meta["edge_run"] = runs
        meta["edge_run_worst_frame"] = worst_frame
        meta["hole_px"] = hole_px
        meta["hole_frame"] = hole_frame
        meta["defect_px"] = defect_px
        meta["defect_frame"] = defect_frame
        meta["motion_pct"] = silhouette_motion_pct(masks)
        meta.pop("src_frames", None)
        meta.pop("src_bgc", None)
        if max(runs.values()) > 0:
            clipped.append((n, runs, worst_frame))
        meta["src_sha256"] = src_hashes.get(n)
        meta["clip_sha256"] = sha256(clip)
        meta["poster_sha256"] = sha256(poster)
        meta["clip_kb"] = round(os.path.getsize(clip) / 1024)
        report[n] = meta
        if args.check:
            for _kind, built in (("clip", clip), ("poster", poster)):
                shipped = os.path.join(outdir, os.path.basename(built))
                if not os.path.exists(shipped) or sha256(shipped) != sha256(built):
                    mismatched.append(os.path.basename(built))
        er = meta["edge_run"]
        bad = []
        if max(er.values()) > 0:
            bad.append(f'잘림 {max(er.values())}px')
        if meta["defect_px"] > HOLE_PX_MAX:
            bad.append(f'키잉구멍 {meta["defect_px"]}px@f{meta["defect_frame"]}')
        if meta["overfill_px"] > OVERFILL_PX_MAX:
            bad.append(f'과채움 {meta["overfill_px"]}px')
        if meta["dropped_persist_frames"] > DROPPED_PERSIST_MAX:
            bad.append(f'소품삭제 {meta["dropped_persist_frames"]}f 연속')

        if meta["motion_pct"] < MOTION_PCT_MIN:
            bad.append(f'idle {meta["motion_pct"]}%')
        mark = "✅" if not bad else "🔴 " + " · ".join(bad)
        if bad:
            defective.append((n, bad))
        print(f'{n:12s} {meta["frames"]:3d}f {meta["w"]:3d}x{meta["h"]} '
              f'{meta["clip_kb"]:5d}KB {meta["fps"]}fps '
              f'hole={meta["hole_px"]:3d} motion={meta["motion_pct"]:5.2f}% '
              f'[{meta["source"].split(":")[0]}] {mark}', flush=True)

    payload = {
        "generator": "scripts/assets/build-mascot-motion.py",
        "ssot": "assets/mascot/v1 (2026-08-07 고정, MANIFEST.sha256)",
        "params": {"target_h": TARGET_H, "frame_step": STEP, "quality": QUALITY, "tol": TOL,
                   "safe_pad": SAFE_PAD, "speck_frac": SPECK_FRAC,
                   "hole_px_max": HOLE_PX_MAX, "motion_pct_min": MOTION_PCT_MIN,
                   "overfill_px_max": OVERFILL_PX_MAX,
                   "dropped_persist_max": DROPPED_PERSIST_MAX,
                   "dropped_min_px": DROPPED_MIN_PX, "dropped_solid_dist": DROPPED_SOLID_DIST,
                   "frame_ms": list(FRAME_MS), "fps": round(1000 / (sum(FRAME_MS) / len(FRAME_MS)), 2)},
        "source_root": "assets/mascot/v2-regen (repo 밖 · MASCOT_VIDEO_SRC 로 지정, 해시 대장은 "
                       "scripts/assets/mascot-motion-SOURCES.sha256)",
        "clips": report,
    }
    # 🔴 결함이 있으면 **빌드 자체가 실패**해야 한다 (삼순 2026-08-17).
    #    종전엔 `defective` 를 모으기만 하고 exit 에 쓰지 않아, 화면에 🔴 를 찍어놓고도
    #    exit 0 으로 끝나 결함 자산이 그대로 썻혔다. 사람이 로그를 읽어야만 알아차리는
    #    경고는 게이트가 아니다.
    if defective:
        print(f"\n❌ 결함 자산 {len(defective)}종 — 빌드 실패:", file=sys.stderr)
        for n, reasons in defective:
            print(f"   · {n}: {' · '.join(reasons)}", file=sys.stderr)
        return 1

    if args.check:
        # 🔴 WebP 26개만 비교하면 **`DERIVED.json` 변조·누락을 못 잡는다** (삼순 2026-08-17).
        #    게이트가 임계값과 측정치를 그 파일에서 읽으므로, manifest 를 고치면
        #    자산을 건드리지 않고도 전체 게이트를 우회할 수 있었다.
        shipped_manifest = None
        if os.path.exists(MANIFEST):
            with open(MANIFEST, encoding="utf-8") as fh:
                try:
                    shipped_manifest = json.load(fh)
                except json.JSONDecodeError:
                    shipped_manifest = None
        if shipped_manifest is None:
            mismatched.append("DERIVED.json(없거나 깨짐)")
        elif json.dumps(shipped_manifest, sort_keys=True, ensure_ascii=False) != \
                json.dumps(payload, sort_keys=True, ensure_ascii=False):
            diff = []
            if shipped_manifest.get("params") != payload["params"]:
                diff.append("params")
            sc, pc = shipped_manifest.get("clips", {}), payload["clips"]
            missing_clips = sorted(set(pc) - set(sc))
            extra_clips = sorted(set(sc) - set(pc))
            if missing_clips:
                diff.append(f"누락 클립 {','.join(missing_clips)}")
            if extra_clips:
                diff.append(f"잉여 클립 {','.join(extra_clips)}")
            changed = sorted(k for k in set(sc) & set(pc) if sc[k] != pc[k])
            if changed:
                diff.append(f"변조 클립 {','.join(changed)}")
            mismatched.append(f"DERIVED.json({' / '.join(diff) or '내용 불일치'})")

        if mismatched:
            print(f"\n❌ 재현 불일치 {len(mismatched)}건: {', '.join(mismatched[:6])}", file=sys.stderr)
            return 1
        print(f"\n✅ 파생 자산 {len(names) * 2}개 + DERIVED.json 이 이 스크립트로 재현됨")
        return 0

    if args.rewrite_ledger or not os.path.exists(SRC_LEDGER):
        with open(SRC_LEDGER, "w", encoding="utf-8") as fh:
            fh.write("# 마스코트 모션 **원본 mp4** 해시 대장 (생성: build-mascot-motion.py)\n")
            fh.write("# 원본은 repo 밖에 산다: assets/mascot/v2-regen (MASCOT_VIDEO_SRC 로 경로 지정).\n")
            fh.write("# 검증: cd $MASCOT_VIDEO_SRC && shasum -a 256 -c <이 파일>\n")
            for n, rel in sorted(VIDEO_SOURCES.items()):
                fh.write(f"{src_hashes[n]}  {rel}\n")

    with open(MANIFEST, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=1, ensure_ascii=False)
        fh.write("\n")
    tot = sum(r["clip_kb"] for r in report.values())
    print(f"\n합계 {tot}KB · manifest → {os.path.relpath(MANIFEST)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
