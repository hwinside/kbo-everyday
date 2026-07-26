"use client";

import { useState } from "react";
import CurrentAtBatCard from "@/components/game/LivePitchByPitch";
import type { PitchDetail } from "@/lib/game/pitch-provider";

const INITIAL_PITCHES: PitchDetail[] = [
  { num: 1, stuff: "직구", speed: 149, resultText: "스트라이크", kind: "strike", count: { ball: 0, strike: 1, out: 1 } },
  { num: 2, stuff: "커브", speed: 126, resultText: "볼", kind: "ball", count: { ball: 1, strike: 1, out: 1 } },
  { num: 3, stuff: "슬라이더", speed: 138, resultText: "파울", kind: "foul", count: { ball: 1, strike: 2, out: 1 } },
  { num: 4, stuff: "직구", speed: 151, resultText: "볼", kind: "ball", count: { ball: 2, strike: 2, out: 1 } },
];

export default function CurrentAtBatQaFixture() {
  const [pitches, setPitches] = useState(INITIAL_PITCHES);

  return (
    <>
      <CurrentAtBatCard
        batterName="오스틴"
        pitcherName="원태인"
        pitches={pitches}
        balls={2}
        strikes={2}
        outs={1}
        updatedAt={new Date().toISOString()}
        scrollOnUpdate
      />
      <button
        className="sr-only"
        data-qa="add-live-pitch"
        onClick={() => setPitches((current) => [
          ...current,
          { num: 5, stuff: "포크", speed: 134, resultText: "헛스윙", kind: "strike", count: { ball: 2, strike: 3, out: 1 } },
        ])}
      >
        새 투구 추가
      </button>
    </>
  );
}
