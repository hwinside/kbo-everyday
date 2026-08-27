"use client";

import { ChevronLeft } from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";

interface GameDetailHeaderProps {
  /** 매치업 제목 (예: "한화 vs SSG") */
  title: string;
}

/**
 * 경기 상세 상단 헤더.
 * 다른 페이지와 동일한 전역 헤더 규격(뒤로가기 + 매치업 제목 + 마이/쪽지 진입점, sticky 고정, 행 높이 44px, safe-area).
 * 상태(경기 중/종료)·시간(18:30 예정)·방송사·구장 정보는 헤더가 아니라 스코어 아래 바디 정보줄로 내렸다.
 * ⚠️ 이 컴포넌트는 스크롤 컨테이너(PullToRefresh, overflow-y-auto) 밖 page-root에 배치해야
 * sticky top-0가 페이지 스크롤 기준으로 고정된다(삼순 NO-GO: 컨테이너 안이면 스크롤 이탈).
 */
export default function GameDetailHeader({ title }: GameDetailHeaderProps) {
  const goBack = useSafeBack("/games");

  return (
    <div
      className="sticky top-0 z-[100] border-b border-border bg-bg-primary"
      style={{ paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}
    >
      <div className="flex min-h-[44px] items-center gap-3 px-5">
        <button
          onClick={goBack}
          aria-label="뒤로가기"
          className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -ml-2.5"
        >
          <ChevronLeft size={24} />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-lg font-bold text-text-primary tracking-tight">{title}</h1>
        <HeaderProfileLink />
      </div>
    </div>
  );
}
