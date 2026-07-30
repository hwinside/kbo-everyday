"use client";

import { useEffect, useState } from "react";
import { Info } from "lucide-react";

/**
 * 7/30 장애 안내 배너 (2026-07-30 하린아빠 지시)
 *
 * 홈 상단 정적 안내. 링크/닫기 버튼 없음.
 * 2026-07-30 23:30 KST 이후 자동 미노출 (코드 게이트) — 이후 배포에서 파일 제거 가능.
 */

const NOTICE_END = new Date("2026-07-30T23:30:00+09:00");

export default function OutageNoticeBanner() {
  const [visible, setVisible] = useState(() => Date.now() < NOTICE_END.getTime());

  // 열어둔 화면에서도 23:30 정각에 자동 소멸 (삼순 1차 리뷰 P1 — mount 1회 계산만으로는
  // 23:29에 연 홈이 refresh 전까지 배너를 유지하는 문제). cleanup 가능한 단일 timer.
  useEffect(() => {
    if (!visible) return;
    // 남은 시간 뒤 소멸 (이미 지난 경우 0ms 후 즉시). effect 본문 동기 setState 금지 룰 준수.
    const remaining = Math.max(0, NOTICE_END.getTime() - Date.now());
    const timer = setTimeout(() => setVisible(false), remaining);
    return () => clearTimeout(timer);
  }, [visible]);

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
          서비스 이용에 불편을 드려 죄송합니다. 오늘 내부 시스템 장애로
          서비스 이용이 원활하지 못했으며, 19:45부터 정상화되었습니다. 같은
          장애가 재발하지 않도록 운영과 모니터링을 더욱 철저히 하겠습니다.
        </p>
      </div>
    </div>
  );
}
