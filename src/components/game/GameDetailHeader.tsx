"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

interface GameDetailHeaderProps {
  status: string;
  time: string;
  stadium: string;
}

export default function GameDetailHeader({ status, time, stadium }: GameDetailHeaderProps) {
  const router = useRouter();

  const titleText =
    status === "live" ? "경기 중" :
    status === "cancelled" ? "경기 취소" :
    status === "final" ? "경기 종료" :
    `${time} 예정`;

  return (
    <div className="flex items-center gap-3 px-5 py-3 sticky top-0 z-[100] bg-bg-primary border-b border-border">
      <button onClick={() => {
        if (window.history.length > 1) {
          router.back();
        } else {
          router.push("/games");
        }
      }} className="rounded-full p-1 text-text-secondary hover:bg-bg-tertiary transition-colors">
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
      <span className="text-[13px] text-text-tertiary">{stadium}</span>
    </div>
  );
}
