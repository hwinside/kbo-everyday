"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";

interface GameDetailHeaderProps {
  status: string;
  time: string;
  stadium: string;
}

export default function GameDetailHeader({ status, time, stadium }: GameDetailHeaderProps) {
  return (
    <div className="flex items-center gap-2 px-4 py-1.5 sticky top-0 z-[100] bg-bg-primary">
      <Link href="/games" className="p-1 -ml-1">
        <ArrowLeft className="w-[18px] h-[18px] text-[#888]" />
      </Link>
      {status === "live" && (
        <span className="text-[10px] font-bold text-white bg-[#e53935] px-1.5 py-0.5 rounded-[3px] animate-pulse">
          ● LIVE
        </span>
      )}
      {status === "final" && (
        <span className="text-[13px] text-[#888]">경기 종료</span>
      )}
      {status === "scheduled" && (
        <span className="text-[13px] text-[#888]">{time} 예정</span>
      )}
      <span className="text-[13px] text-[#888]">{stadium}</span>
    </div>
  );
}
