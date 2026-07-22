// 회신 불가(자동 발송 전용) 시스템 계정 공통 판정 — 뉴스클리퍼 + 긴급공지.
// 서버(dispatch)와 클라(쪽지 대화방 입력창/배너) 공용 SSOT.
// 닉네임은 위조 가능하므로 판정은 반드시 user_id 기준으로 한다.
import { NEWS_CLIPPER_IDS, CLIPPER_AUTO_REPLY_TEXT } from "./news-clippers";
import { URGENT_NOTICE_USER_ID, URGENT_NOTICE_AUTO_REPLY_TEXT } from "./urgent-notice";

/** 회신 불가(자동 발송 전용) 계정 여부 */
export function isNoReplySender(userId: string | null | undefined): boolean {
  if (!userId) return false;
  return NEWS_CLIPPER_IDS.has(userId) || userId === URGENT_NOTICE_USER_ID;
}

/** 회신 불가 계정에 답장 시 계정별 자동응답 문구 */
export function noReplyAutoReplyText(userId: string): string {
  if (userId === URGENT_NOTICE_USER_ID) return URGENT_NOTICE_AUTO_REPLY_TEXT;
  return CLIPPER_AUTO_REPLY_TEXT;
}

/** 쪽지 대화방 입력창/배너에 노출할 "전용 계정" 안내 문구 */
export function noReplyBannerLabel(userId: string | null | undefined): string {
  if (userId === URGENT_NOTICE_USER_ID) {
    return "긴급공지 전용 계정입니다. 문의는 '피드백 보내기'를 이용해주세요.";
  }
  return "뉴스클리핑 전용 계정입니다. 문의는 '피드백 보내기'를 이용해주세요.";
}
