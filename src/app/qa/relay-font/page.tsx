/**
 * QA fixture — 실시간 문자중계 글자 크기/레이아웃 회귀 (중계 글자 확대 PR)
 *
 * 용도: scripts/qa/ui-smoke-relay-font.mjs 가 320/360/390px 뷰포트에서
 *       RelayPlayLine 본문(14px)/보조(12px) 폰트와 가로 overflow를 실측.
 * 접근: dev 전용 — production 빌드에서는 404 (유저 노출 금지).
 * 예시: /qa/relay-font
 *
 * 현재/이전 이닝 모두 실제 크관 탭과 동일한 RelayPlayLine 컴포넌트를 렌더하므로
 * 마크업 drift가 없다.
 */
import { notFound } from "next/navigation";
import RelayPlayLine from "@/components/game/RelayPlayLine";
import CurrentAtBatQaFixture from "./CurrentAtBatQaFixture";
import type { PlayEvent } from "@/app/api/game-relay/route";
import type { PitchDetail } from "@/lib/game/pitch-provider";

export const metadata = { robots: "noindex,nofollow" };

// 긴 결과 + 긴 보조문구 최악 케이스(좁은 폭 줄바꿈/overflow 방어 검증용)
const COMPLETED_PITCHES: PitchDetail[] = [
  { num: 1, stuff: "직구", speed: 149, resultText: "스트라이크", kind: "strike", count: { ball: 0, strike: 1, out: 1 } },
  { num: 2, stuff: "커브", speed: 126, resultText: "볼", kind: "ball", count: { ball: 1, strike: 1, out: 1 } },
  { num: 3, stuff: "슬라이더", speed: 138, resultText: "파울", kind: "foul", count: { ball: 1, strike: 2, out: 1 } },
];

const PLAYS: PlayEvent[] = [
  { batterName: "김혜성", result: "중견수 방면 1루타", type: "hit", extras: ["1루주자 홈까지 진루 / 득점"], pitches: COMPLETED_PITCHES },
  { batterName: "에드먼", result: "우월 3점 홈런", type: "homerun", extras: ["구자욱 홈인 / 오재일 홈인 / 3타점"] },
  { batterName: "구자욱", result: "삼진 아웃 (헛스윙)", type: "strikeout", extras: [] },
  { batterName: "이재현", result: "볼넷으로 걸어나감", type: "walk", extras: ["만루 상황 전개"] },
];

function Inning({ label, teamName, plays }: { label: string; teamName: string; plays: PlayEvent[] }) {
  return (
    <div className="border-b border-border/30">
      <div className="flex items-center gap-1.5 px-4 py-2">
        <span className="text-xs font-bold text-accent">{label}</span>
        <span className="text-[11px] text-text-tertiary">{teamName} 공격</span>
      </div>
      <div className="px-4 pb-2 space-y-1.5" data-qa="relay-plays">
        {plays.map((play, idx) => (
          <RelayPlayLine key={idx} play={play} />
        ))}
      </div>
    </div>
  );
}

export default function RelayFontQaPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="min-h-screen bg-black">
      <div data-qa="relay-root" className="bg-bg-tertiary border-b border-border max-h-[40vh] overflow-y-auto">
        <CurrentAtBatQaFixture />
        <Inning label="1회초" teamName="키움" plays={PLAYS} />
        <Inning label="3회말" teamName="삼성" plays={PLAYS} />
      </div>
      <div data-qa="chat-space" className="flex min-h-72 items-center justify-center text-sm text-text-tertiary">
        크관 채팅 영역
      </div>
    </div>
  );
}
