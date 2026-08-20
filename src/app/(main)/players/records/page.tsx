"use client";

import { ChevronLeft } from "lucide-react";
import { useSafeBack } from "@/lib/hooks/useSafeBack";
import HeaderProfileLink from "@/components/ui/HeaderProfileLink";
import RecordRoom from "@/components/players/RecordRoom";

export default function PlayerRecordsPage() {
  const goBack = useSafeBack("/players");

  return (
    <div className="mx-auto max-w-lg px-5">
      <div className="sticky top-0 z-30 border-b -mx-5 px-5 bg-bg-primary" style={{ borderColor: "var(--color-border)", paddingTop: "var(--safe-area-inset-top, env(safe-area-inset-top, 0px))", marginTop: "calc(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)) * -1)" }}>
        <header className="min-h-[44px] flex items-center gap-3">
          <button
            onClick={goBack}
            aria-label="뒤로가기"
            className="flex h-11 w-11 items-center justify-center rounded-full text-text-secondary hover:bg-bg-tertiary transition-colors -ml-2.5"
          >
            <ChevronLeft size={24} />
          </button>
          <h1 className="text-lg font-bold text-text-primary tracking-tight flex-1">선수기록실</h1>
          <HeaderProfileLink />
        </header>
      </div>

      <p className="mt-2 mb-3 text-xs text-text-tertiary">
        기록을 선택하면 그 순으로 정렬됩니다 · 리그 전체
      </p>

      <RecordRoom />
    </div>
  );
}
