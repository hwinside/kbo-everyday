"use client";

import { ChevronLeft } from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";

interface GameDetailHeaderProps {
  status: string;
  /** 매치업 제목 (예: "한화 vs SSG") */
  title: string;
}

/**
 * 경기 상세 상단 헤더.
 * 다른 페이지와 동일한 전역 헤더 규격(뒤로가기 + 매치업 제목 + 마이/쪽지 진입점, sticky 고정, py-2, safe-area).
 * 시간(18:30 예정)·상태·방송사·구장 정보는 헤더가 아니라 스코어 아래 바디 정보줄로 내렸다.
 * ⚠️ 이 컴포넌트는 스크롤 컨테이너(PullToRefresh, overflow-y-auto) 밖 page-root에 배치해야
 * sticky top-0가 페이지 스크롤 기준으로 고정된다(삼순 NO-GO: 컨테이너 안이면 스크롤 이탈).
 */
export default function GameDetailHeader({ status, title }: GameDetailHeaderProps) {
  const goBack = useSafeBack("/games");

  return (
    <div
      className="sticky top-0 z-[100] border-b border-border bg-bg-primary"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}
    >
      <div className="flex items-center gap-3 px-5 py-2">
        <button
          onClick={goBack}
          aria-label="뒤로가기"
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <h1 className="truncate text-lg font-bold text-text-primary tracking-tight">{title}</h1>
          {status === "live" && (
            <span className="shrink-0 text-[10px] font-bold text-white bg-[#e53935] px-1.5 py-0.5 rounded-[3px] animate-pulse">
              LIVE
            </span>
          )}
        </div>
        <HeaderProfileLink />
      </div>
    </div>
  );
}
