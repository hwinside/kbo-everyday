#!/usr/bin/env python3
"""Build the home button's small assets from the committed, approved motion assets.

python3 scripts/assets/build-mascot-entry.py          # write four WebPs + provenance
python3 scripts/assets/build-mascot-entry.py --check  # in-memory reproduction, no writes

Requires Pillow 11.3.0 / libwebp 1.5.0 (recorded in DERIVED.json). No external
SSOT, network, frame sampling, cropping, keying, or source mutation. The existing
96px chat mascot keeps its 192px-high assets. New URLs are versioned separately
so browsers with the old /mascot/motion/ files cached cannot serve those instead.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "public/mascot/motion"
OUTPUT = ROOT / "public/mascot/entry/v1"
CLIPS = ("swing", "pitching")
HEIGHT = 96  # 29 CSS px * 3 DPR = 87; preserve the exact 1:2 aspect ratio.
QUALITY = 85


def digest(data):
    return hashlib.sha256(data).hexdigest()


def decode(data):
    with Image.open(io.BytesIO(data)) as im:
        loop = im.info.get("loop")
        frames, durations = [], []
        for index in range(im.n_frames):
            im.seek(index)
            im.load()  # WebP duration is populated by load(), not seek().
            frames.append(im.convert("RGBA"))
            durations.append(im.info.get("duration", 0))
        return frames, durations, loop


def build():
    toolchain = {"pillow": Image.__version__, "webp": features.version("webp")}
    if toolchain != {"pillow": "11.3.0", "webp": "1.5.0"}:
        raise SystemExit(f"Use the recorded encoder versions for reproduction: {toolchain}")
    manifest = {
        "version": 1,
        "toolchain": toolchain,
        "params": {"height": HEIGHT, "resample": "LANCZOS", "quality": QUALITY,
                   "method": 6, "exact": True, "poster_lossless": True},
        "timing": "All input frames and durations retained; encoder may merge adjacent identical frames.",
        "assets": {},
    }
    outputs = {}
    for clip in CLIPS:
        for poster in (False, True):
            name = f"{clip}{'-poster' if poster else ''}.webp"
            source_data = (SOURCE / name).read_bytes()
            frames, durations, loop = decode(source_data)
            width, height = frames[0].size
            if height != 192 or width % 2:
                raise ValueError(f"Unexpected source dimensions: {name}")
            if not poster and (loop != 0 or any(d <= 0 for d in durations)):
                raise ValueError(f"Unexpected source playback: {name}")
            scaled = [f.resize((width // 2, HEIGHT), Image.Resampling.LANCZOS) for f in frames]
            buffer = io.BytesIO()
            options = {"format": "WEBP", "method": 6, "exact": True}
            if poster:
                scaled[0].save(buffer, lossless=True, **options)
            else:
                scaled[0].save(buffer, save_all=True, append_images=scaled[1:],
                               duration=durations, loop=loop, quality=QUALITY, **options)
            data = buffer.getvalue()
            encoded, encoded_durations, encoded_loop = decode(data)
            if sum(durations) != sum(encoded_durations) or loop != encoded_loop:
                raise ValueError(f"Playback changed: {name}")
            if len(encoded) < (1 if poster else 2) or len(data) >= len(source_data):
                raise ValueError(f"Not a smaller equivalent asset: {name}")
            manifest["assets"][name] = {
                "source": f"public/mascot/motion/{name}",
                "source_sha256": digest(source_data), "source_bytes": len(source_data),
                "source_size": [width, height], "source_frames": len(frames),
                "source_durations_ms": durations,
                "sha256": digest(data), "bytes": len(data),
                "size": list(encoded[0].size), "frames": len(encoded),
                "durations_ms": encoded_durations, "loop": encoded_loop,
            }
            outputs[name] = data
    outputs["DERIVED.json"] = (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode()
    return outputs, manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    outputs, manifest = build()
    if args.check:
        for name, expected in outputs.items():
            if not (OUTPUT / name).is_file() or (OUTPUT / name).read_bytes() != expected:
                raise SystemExit(f"Reproduction mismatch: {name}")
        print("Mascot entry: four assets + provenance reproduced byte-for-byte")
    else:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        for name, data in outputs.items():
            (OUTPUT / name).write_bytes(data)
    for name, item in manifest["assets"].items():
        print(f"{name}: {item['source_bytes']} -> {item['bytes']} bytes; "
              f"{sum(item['durations_ms'])}ms, loop={item['loop']}")


if __name__ == "__main__":
    main()
