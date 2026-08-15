"use client";

import Image from "next/image";
import type { BroadcastChannel } from "@/lib/broadcast-channels";

/**
 * 중계방송사 배지 묶음.
 * - 로고 확보 채널(logoSrc 존재): 흰색 둥근 칩 안에 원본 컬러 로고(다크모드 대응).
 * - 로고 미확보 채널: 기존 텍스트 배지 fallback.
 * 깨진 이미지 노출 방지를 위해 logoSrc 있는 채널만 로고 경로로 렌더.
 */
export default function BroadcastBadges({
  channels,
  compact = false,
}: {
  channels?: BroadcastChannel[];
  /** 경기탭 카드처럼 행 높이가 고정된 곳용 — 칩/로고를 한 단계 줄이고 줄바꿈을 막는다. */
  compact?: boolean;
}) {
  if (!channels || channels.length === 0) return null;
  return (
    <div className={`flex items-center ${compact ? "gap-0.5" : "flex-wrap gap-1"}`}>
      {channels.map((ch) =>
        ch.logoSrc ? (
          <span
            key={ch.code}
            className={`inline-flex items-center justify-center rounded bg-white ${compact ? "h-[13px] px-[3px]" : "h-[18px] px-1 py-0.5"}`}
            title={ch.name}
          >
            <Image
              src={ch.logoSrc}
              alt={ch.name}
              width={40}
              height={14}
              unoptimized
              className={`w-auto object-contain ${compact ? "h-[10px]" : "h-[14px]"}`}
            />
          </span>
        ) : (
          <span
            key={ch.code}
            className={`rounded bg-text-tertiary/10 font-medium text-text-tertiary ${
              compact ? "px-1 text-[9px] leading-[13px]" : "px-1.5 py-0.5 text-[10px]"
            }`}
          >
            {ch.name}
          </span>
        )
      )}
    </div>
  );
}
