"use client";

import { useState } from "react";
import { Info } from "lucide-react";

/**
 * 7/30 장애 안내 배너 (2026-07-30 하린아빠 지시)
 *
 * 홈 상단 정적 안내. 링크/닫기 버튼 없음.
 * 2026-07-30 23:30 KST 이후 자동 미노출 (코드 게이트) — 이후 배포에서 파일 제거 가능.
 */

const NOTICE_END = new Date("2026-07-30T23:30:00+09:00");

export default function OutageNoticeBanner() {
  const [visible] = useState(() => Date.now() < NOTICE_END.getTime());

  if (!visible) return null;

  return (
    <div
      role="status"
      className="mb-4 flex items-start gap-3 rounded-2xl border border-white/10 bg-bg-secondary px-4 py-3.5"
    >
      <Info
        size={18}
        className="mt-0.5 shrink-0 text-text-tertiary"
        aria-hidden="true"
      />
      <div>
        <p className="text-[13px] font-semibold leading-[19px] text-text-primary">
          서비스 이용 안내
        </p>
        <p className="mt-1 text-[13px] leading-[19px] text-text-secondary break-keep">
          오늘 저녁 내부 장애로 경기 중계·알림 서비스가 원활하지 못했습니다.
          19:45부터 정상화되었습니다. 불편을 드려 죄송하며, 같은 장애가
          재발하지 않도록 더 철저히 운영하겠습니다.
        </p>
      </div>
    </div>
  );
}
