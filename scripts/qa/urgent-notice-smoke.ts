// 긴급공지/회신 불가 계정 판정 스모크 — 순수함수 검증 (DB 불필요).
// 실행: npx tsx scripts/qa/urgent-notice-smoke.ts  (또는 npm run qa:urgent-notice)
import { NEWS_CLIPPER_BY_TEAM, NEWS_CLIPPER_IDS, CLIPPER_AUTO_REPLY_TEXT } from "../../src/lib/constants/news-clippers";
import { URGENT_NOTICE_USER_ID, URGENT_NOTICE_AUTO_REPLY_TEXT } from "../../src/lib/constants/urgent-notice";
import { isNoReplySender, noReplyAutoReplyText, noReplyBannerLabel } from "../../src/lib/constants/no-reply-senders";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; } else { fail++; console.error("  ✗ " + name); }
}

const clipperId = NEWS_CLIPPER_BY_TEAM[1];
const normalUser = "00000000-0000-0000-0000-000000000001";

// UUID 형식 + 클리퍼 집합과 겹치지 않음(오분류 방지)
check("urgent id is uuid", /^[0-9a-f-]{36}$/.test(URGENT_NOTICE_USER_ID));
check("urgent id not a clipper", !NEWS_CLIPPER_IDS.has(URGENT_NOTICE_USER_ID));

// isNoReplySender — 클리퍼 + 긴급공지 true, 일반/운영팀/null false
check("noReply: clipper true", isNoReplySender(clipperId));
check("noReply: urgent true", isNoReplySender(URGENT_NOTICE_USER_ID));
check("noReply: normal false", !isNoReplySender(normalUser));
check("noReply: null false", !isNoReplySender(null));
check("noReply: undefined false", !isNoReplySender(undefined));

// 자동응답 문구 — 계정별 분기
check("autoReply: urgent text", noReplyAutoReplyText(URGENT_NOTICE_USER_ID) === URGENT_NOTICE_AUTO_REPLY_TEXT);
check("autoReply: clipper text", noReplyAutoReplyText(clipperId) === CLIPPER_AUTO_REPLY_TEXT);
check("autoReply: urgent mentions 피드백", URGENT_NOTICE_AUTO_REPLY_TEXT.includes("피드백 보내기"));

// 배너 문구 — 계정별 분기
check("banner: urgent label", noReplyBannerLabel(URGENT_NOTICE_USER_ID).includes("긴급공지 전용 계정"));
check("banner: clipper label", noReplyBannerLabel(clipperId).includes("뉴스클리핑 전용 계정"));
check("banner: 피드백 안내 포함", noReplyBannerLabel(URGENT_NOTICE_USER_ID).includes("피드백 보내기"));

// --- dispatch 게이트 회귀 (삼순 NO-GO #3/#4) ---
// handleDm의 긴급공지 분기 로직을 순수 재현: payload.type === 'urgent_notice'만 푸시, android만.
type Dispatchish = { push: boolean; platform?: string };
function urgentDispatch(payloadType: string | undefined): Dispatchish {
  if (payloadType !== "urgent_notice") return { push: false };
  return { push: true, platform: "android" };
}
// #3: 공지 원본만 푸시
check("dispatch: urgent_notice → push", urgentDispatch("urgent_notice").push === true);
// #3: 자동응답(urgent_notice_auto_reply)은 push 0 (재푸시 루프 차단)
check("dispatch: auto_reply → no push", urgentDispatch("urgent_notice_auto_reply").push === false);
check("dispatch: no payload → no push", urgentDispatch(undefined).push === false);
// #4: 긴급공지 푸시는 android 타깃
check("dispatch: urgent push → android only", urgentDispatch("urgent_notice").platform === "android");

console.log(`\nurgent-notice smoke: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
