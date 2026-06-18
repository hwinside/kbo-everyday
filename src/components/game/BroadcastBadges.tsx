"use client";

import Image from "next/image";
import type { BroadcastChannel } from "@/lib/broadcast-channels";

/**
 * 중계방송사 배지 묶음.
 * - 로고 확보 채널(logoSrc 존재): 흰색 둥근 칩 안에 원본 컬러 로고(다크모드 대응).
 * - 로고 미확보 채널: 기존 텍스트 배지 fallback.
 * 깨진 이미지 노출 방지를 위해 logoSrc 있는 채널만 로고 경로로 렌더.
 */
export default function BroadcastBadges({ channels }: { channels?: BroadcastChannel[] }) {
  if (!channels || channels.length === 0) return null;
  return (
    <div className="flex items-center gap-1">
      {channels.map((ch) =>
        ch.logoSrc ? (
          <span
            key={ch.code}
            className="inline-flex items-center justify-center rounded bg-white px-1 py-0.5 h-[18px]"
            title={ch.name}
          >
            <Image
              src={ch.logoSrc}
              alt={ch.name}
              width={40}
              height={14}
              unoptimized
              className="object-contain h-[14px] w-auto"
            />
          </span>
        ) : (
          <span
            key={ch.code}
            className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-text-tertiary/10 text-text-tertiary"
          >
            {ch.name}
          </span>
        )
      )}
    </div>
  );
}
