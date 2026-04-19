import { permanentRedirect } from "next/navigation";

/**
 * 레거시 선수 상세 라우트 — SSOT 통합을 위해 `/community/players/[kboId]`로 영구 리다이렉트.
 *
 * 이전 구현은 LG 6명 하드코딩(`ALL_LG_PLAYERS`)에 의존했고, kboId(예: 55130 톨허스트)가 들어오면
 * 전부 "선수 정보를 준비 중" 404로 빠졌음. 전체 선수 동일 원칙 적용을 위해 단일 라우트로 통합.
 *
 * 관련 변경: MatchupCard / 모든 선수 링크가 /community/players/[kboId]로 통일됨.
 */
export default async function LegacyPlayerRedirect({
  params,
}: {
  params: Promise<{ teamId: string; playerId: string }>;
}) {
  const { playerId } = await params;
  permanentRedirect(`/community/players/${playerId}`);
}
