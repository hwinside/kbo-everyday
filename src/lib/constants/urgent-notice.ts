// 긴급공지 발신 계정 — 회신 불가(자동 발송 전용) 시스템 계정.
// 뉴스클리퍼(news-clippers.ts)와 동일하게 운영팀 CS 인입함과 분리해, 유저가 공지에
// 답장해도 CS 릴레이를 오염시키지 않고 회신 스팸도 막는다 (2026-07-19 하린아빠 지시).
// 계정은 scripts/setup-urgent-notice-account.ts로 prod에 생성된 실계정
// (auth.users urgent-notice@keubo.fan + profiles "긴급공지", team_id=0 시스템 관례).
export const URGENT_NOTICE_USER_ID = "cea40688-d0ff-49bd-a101-4b7cf9339b0e";

/** 긴급공지 계정에 답장 시 자동응답 문구 (대화방당 24h 1회, 하린아빠 지정 톤) */
export const URGENT_NOTICE_AUTO_REPLY_TEXT =
  "긴급공지 계정은 회신을 받지 않습니다. 문의하실 내용이 있다면 '피드백 보내기'를 이용해주세요.";
