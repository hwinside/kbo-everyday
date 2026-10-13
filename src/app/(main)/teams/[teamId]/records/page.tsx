import { TEAMS } from "@/lib/constants/teams";
import RecordsClient from "./RecordsClient";

// 정적 프리렌더(삼순 승인 스코프, Vercel 비용 트랙 PR③):
// records 페이지도 client-only(모든 데이터 클라 fetch)라 서버 렌더에 유저별
// 콘텐츠가 없다. 10구단 slug 정적 산출로 요청당 함수 호출 제거.
export function generateStaticParams() {
  return TEAMS.map((team) => ({ teamId: team.slug }));
}

export default function TeamRecordsPage() {
  return <RecordsClient />;
}
