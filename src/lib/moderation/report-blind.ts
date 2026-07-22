// 신고 자동 블라인드 안내 — 순수 함수 모듈(supabase 싱글톤 미로드).
// 실제 블라인드 전환/outbox 적재는 DB 트리거(auto_blind_on_report)가,
// 안내 쪽지 발송은 크론(/api/cron/report-blind-notify)이 담당한다.
// 여기서는 임계값 상수와 쪽지 문안(대상 라벨 치환)만 제공한다.

/** 서로 다른 신고자 수가 이 값 이상이면 자동 블라인드 대상이 된다. (참고 상수) */
export const REPORT_BLIND_THRESHOLD = 3;

export type ReportTargetType = "post" | "comment" | "chat";

/** 안내 쪽지에 들어갈 대상 유형 한글 라벨. */
export function blindTargetLabel(targetType: string): string {
  switch (targetType) {
    case "chat":
      return "채팅 메시지";
    case "post":
      return "게시글";
    case "comment":
      return "댓글";
    default:
      return "게시물";
  }
}

/** 블라인드 처리 안내 쪽지 문안(하린아빠 승인 문안, 대상 라벨만 치환). */
export function buildBlindNotice(label: string): string {
  return [
    "안녕하세요, 크보팬 운영팀입니다.",
    `회원님이 작성하신 ${label}이(가) 여러 이용자의 신고를 받아, 커뮤니티 운영정책(욕설·비방·인신공격 금지)에 따라 블라인드 처리되었음을 안내드립니다.`,
    "크보팬은 모든 팬이 존중받으며 응원할 수 있는 공간을 지향합니다.",
    "반복될 경우 채팅 이용이 제한될 수 있습니다. 건강한 응원 문화에 협조 부탁드립니다.",
  ].join("\n");
}
