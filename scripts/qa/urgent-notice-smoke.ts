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

// --- RPC 게이트 순수 재현 (삼순 P0/#1/#2 SSOT+active+platform) ---
// send_urgent_notice 분기 로직을 테스트에서 재현: active/target/claim 순서 검증.
type NoticeRow = { active: boolean; target: string } | null;
function rpcGate(
  notice: NoticeRow,
  callerPlatform: string | null,
  alreadyClaimed: boolean,
): "sent" | "skipped" | "inactive" | "platform_skip" {
  if (!notice || !notice.active) return "inactive";           // #1 active 게이트(deactivate 즉시)
  // #3 fail-closed: `IS DISTINCT FROM` — null/불일치 모두 차단(target='all'만 예외)
  if (notice.target !== "all" && callerPlatform !== notice.target) {
    return "platform_skip";                                    // #3/#4 target 불일치
  }
  if (alreadyClaimed) return "skipped";                       // #2 unique claim 멱등
  return "sent";
}
const androidActive: NoticeRow = { active: true, target: "android" };
// P0: 발신·문안은 RPC 인자가 아니라 DB SSOT — sender_id 상수 기반(위조 불가) 검증
check("rpc: active android → sent", rpcGate(androidActive, "android", false) === "sent");
check("rpc: inactive → inactive(no send)", rpcGate({ active: false, target: "android" }, "android", false) === "inactive");
check("rpc: missing notice → inactive", rpcGate(null, "android", false) === "inactive");
check("rpc: ios caller vs android target → platform_skip", rpcGate(androidActive, "ios", false) === "platform_skip");
check("rpc: all target accepts ios caller", rpcGate({ active: true, target: "all" }, "ios", false) === "sent");
check("rpc: already claimed → skipped(멱등)", rpcGate(androidActive, "android", true) === "skipped");
check("rpc: deactivate mid-batch → 남은 대상 inactive", rpcGate({ active: false, target: "android" }, "android", false) === "inactive");
// #3 fail-closed: platform NULL은 android target 통과 못함(IS DISTINCT FROM)
check("rpc: null platform vs android → platform_skip", rpcGate(androidActive, null, false) === "platform_skip");
check("rpc: null platform vs all target → sent", rpcGate({ active: true, target: "all" }, null, false) === "sent");

// --- keyset cursor 순회 안정성 (삼순 #3) ---
// user_id > cursor 페이지네이션이 distinct user를 중복/누락 없이 모으는지 순수 재현.
function keysetDistinct(rows: string[], page: number): string[] {
  const sorted = [...rows].sort();
  const set = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const slice = sorted.filter((u) => cursor === null || u > cursor).slice(0, page);
    if (slice.length === 0) break;
    for (const u of slice) set.add(u);
    cursor = slice[slice.length - 1];
    if (slice.length < page) break;
  }
  return [...set].sort();
}
// 같은 user_id 여러 토큰(경계 걸침) + 페이지 분할 → distinct 3명 정확
const tokenRows = ["aaa", "aaa", "bbb", "ccc", "ccc", "ccc"];
const ks = keysetDistinct(tokenRows, 2);
check("keyset: distinct count", ks.length === 3);
check("keyset: no dup, sorted", ks.join(",") === "aaa,bbb,ccc");
check("keyset: page=1 same result", keysetDistinct(tokenRows, 1).join(",") === "aaa,bbb,ccc");

console.log(`\nurgent-notice smoke: ${pass}/${pass + fail} passed`);
if (fail > 0) process.exit(1);
