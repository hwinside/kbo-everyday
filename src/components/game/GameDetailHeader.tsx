"use client";

import { ChevronLeft } from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";

interface GameDetailHeaderProps {
  status: string;
}

/**
 * 경기 상세 상단 헤더.
 * 다른 페이지와 동일한 전역 헤더 규격(뒤로가기 + 제목, sticky 고정, py-2, safe-area).
 * 시간(18:30 예정)·방송사·구장 정보는 헤더가 아니라 스코어 아래 바디 정보줄로 내렸다.
 */
export default function GameDetailHeader({ status }: GameDetailHeaderProps) {
  const goBack = useSafeBack("/games");

  const titleText =
    status === "live" ? "경기 중" :
    status === "cancelled" ? "경기 취소" :
    status === "final" ? "경기 종료" : "경기 예정";

  return (
    <div
      className="sticky top-0 z-[100] border-b border-border bg-bg-primary"
      style={{ paddingTop: "env(safe-area-inset-top, 0px)", marginTop: "calc(env(safe-area-inset-top, 0px) * -1)" }}
    >
      <div className="flex items-center gap-3 px-5 py-2">
        <button
          onClick={goBack}
          className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors"
        >
          <ChevronLeft size={24} />
        </button>
        <div className="flex items-center gap-2 flex-1">
          <h1 className="text-lg font-bold text-text-primary tracking-tight">{titleText}</h1>
          {status === "live" && (
            <span className="text-[10px] font-bold text-white bg-[#e53935] px-1.5 py-0.5 rounded-[3px] animate-pulse">
              LIVE
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
