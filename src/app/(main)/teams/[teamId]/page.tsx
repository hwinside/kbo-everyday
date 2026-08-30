import { TEAMS } from "@/lib/constants/teams";
import TeamHubClient from "./TeamHubClient";

// 정적 프리렌더(삼순 승인 스코프, Vercel 비용 트랙 PR③):
// 페이지 자체는 client-only(모든 데이터 클라 fetch)라 서버 렌더에 유저별
// 콘텐츠가 없다. 10구단 slug를 빌드 타임에 정적 산출해 요청당 함수 호출을
// 제거한다. TEAMS는 정규 10구단만 포함(올스타는 별도 레지스트리) —
// 미등록 slug는 기존과 동일하게 on-demand 렌더(클라에서 "존재하지 않는
// 구단입니다" 처리).
export function generateStaticParams() {
  return TEAMS.map((team) => ({ teamId: team.slug }));
}

export default function TeamHubPage() {
  return <TeamHubClient />;
}
