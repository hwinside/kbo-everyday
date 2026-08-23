/**
 * QA fixture — 크관 자동 포커싱 토글 회귀 (PR #1291)
 *
 * 용도: scripts/qa/ui-smoke-game-chat-visibility.mjs 의 autofocus 축이
 *       실제 hook(useKgwanAutoFocus) + 실제 소비자(CurrentAtBatCard
 *       scrollOnUpdate) 배선으로 "새 투구 → 자동 스크롤 ON/OFF·reload 영속·
 *       ON 복귀"를 결정론적으로 실측.
 * 접근: dev 전용 — production 빌드에서는 404 (유저 노출 금지).
 * 예시: /qa/kgwan-autofocus
 */
import { notFound } from "next/navigation";
import KgwanAutoFocusQaFixture from "./KgwanAutoFocusQaFixture";

export const metadata = { robots: "noindex,nofollow" };

export default function KgwanAutoFocusQaPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="min-h-screen bg-black">
      <KgwanAutoFocusQaFixture />
    </div>
  );
}
