import VenueStatsDashboard from "@/components/my/VenueStatsDashboard";

/**
 * 직관 통계(직관 요정 지수) — 일반 공개.
 *
 * 관리자 전용(`AdminOnly`) 으로 실환경 QA 를 마친 뒤 래퍼를 벗겼다.
 * 데이터 자체는 이전부터 소유자 인증 API(`/api/me/venue-stats`) 가 본인 것만
 * 내려주므로, 이 변경은 표시 게이트만 열고 서버 인가는 그대로다.
 */
export default function VenueStatsPage() {
  return <VenueStatsDashboard />;
}
