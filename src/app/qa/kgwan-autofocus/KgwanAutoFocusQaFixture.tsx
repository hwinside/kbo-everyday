"use client";

import { useState } from "react";
import { LocateFixed, LocateOff } from "lucide-react";
import CurrentAtBatCard from "@/components/game/LivePitchByPitch";
import { useKgwanAutoFocus } from "@/hooks/useKgwanAutoFocus";
import type { PitchDetail } from "@/lib/game/pitch-provider";

// 크관 자동 포커싱 토글 QA 픽스처 — 실제 hook(useKgwanAutoFocus)과 실제 소비자
// (CurrentAtBatCard scrollOnUpdate)를 같은 배선으로 태운다. 라이브 경기 없이
// "새 투구 → 자동 스크롤 ON/OFF" 를 결정론적으로 검증하기 위한 페이지
// (relay-font 픽스처와 동일 패턴). 토글 버튼 마크업은 GameChat의 실버튼과
// 동일한 aria-label 계약을 쓴다.
const INITIAL_PITCHES: PitchDetail[] = [
  { num: 1, stuff: "직구", speed: 149, resultText: "스트라이크", kind: "strike", count: { ball: 0, strike: 1, out: 1 } },
  { num: 2, stuff: "커브", speed: 126, resultText: "볼", kind: "ball", count: { ball: 1, strike: 1, out: 1 } },
];

export default function KgwanAutoFocusQaFixture() {
  const { enabled: autoFocusEnabled, toggle: toggleAutoFocus } = useKgwanAutoFocus();
  const [pitches, setPitches] = useState(INITIAL_PITCHES);

  return (
    <>
      <div className="flex justify-end gap-2 px-4 py-2">
        <button
          type="button"
          data-qa="autofocus-toggle"
          onClick={toggleAutoFocus}
          className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text-secondary"
          aria-label={autoFocusEnabled ? "자동 포커싱 끄기" : "자동 포커싱 켜기"}
        >
          {autoFocusEnabled ? <LocateOff size={14} /> : <LocateFixed size={14} />}
          {autoFocusEnabled ? "자동 포커싱 끄기" : "자동 포커싱 켜기"}
        </button>
      </div>
      {/* 카드가 초기 viewport 밖(아래)에 있도록 스페이서 — 자동 스크롤 발생 여부를
          window.scrollY 변화로 관측한다. */}
      <div style={{ height: "150vh" }} data-qa="spacer" />
      <CurrentAtBatCard
        batterName="오스틴"
        batOrder={4}
        pitcherName="원태인"
        pitches={pitches}
        balls={2}
        strikes={2}
        outs={1}
        updatedAt={new Date().toISOString()}
        scrollOnUpdate={autoFocusEnabled}
      />
      <button
        className="sr-only"
        data-qa="add-live-pitch"
        onClick={() => setPitches((current) => [
          ...current,
          {
            num: current.length + 1,
            stuff: "포크",
            speed: 134,
            resultText: "헛스윙",
            kind: "strike",
            count: { ball: 2, strike: 3, out: 1 },
          },
        ])}
      >
        새 투구 추가
      </button>
    </>
  );
}
