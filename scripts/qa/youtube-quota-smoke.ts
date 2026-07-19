/**
 * Smoke/regression — 공유 YouTube quota 원장 순수 로직.
 *
 * 검증(src/lib/video/youtube-quota.ts):
 *  · getQuotaDate — Pacific(LA) 날짜 경계 (KST 16:00 리셋과 일치)
 *  · quotaJobStatus — quota degrade는 warning(성공 오표기 교정), hardError는 error
 *  · reserveQuota — RPC 응답 매핑 + RPC 실패 시 백스톱(allowed=true+ledgerError)
 *  · resolveQuotaCap — 하드 리밋(10k) 강제 clamp (삼순 #709 2번)
 *  · recordQuota — await/durable + RPC 오류 노출(throw 안 함) (삼순 #709 2번)
 *  · QuotaCounter — 실제 시도별 units 누적 (삼순 #709 2번)
 *  · isQuotaSignal/YouTubeApiError — 구조화 quota 판별(status·reason·문구) (삼순 #709 3번)
 *
 * 실행: npx tsx scripts/qa/youtube-quota-smoke.ts  (npm run qa:youtube-quota)
 */
import "./_smoke-env";
import {
  getQuotaDate,
  quotaJobStatus,
  reserveQuota,
  recordQuota,
  resolveQuotaCap,
  YT_QUOTA_DAILY_DEFAULT,
  YT_QUOTA_HARD_MAX,
  YT_UNITS_SEARCH,
  YT_UNITS_VIDEOS_LIST,
  newQuotaCounter,
  countSearch,
  countVideoList,
  withQuotaRecording,
  isQuotaSignal,
  quotaInfoFromError,
  extractYouTubeError,
  YouTubeApiError,
} from "@/lib/video/youtube-quota";

let fail = 0;
function ok(name: string, cond: boolean) {
  console.log(`${cond ? "✅" : "❌"} ${name}`);
  if (!cond) fail++;
}

// ── resolveQuotaCap: 비정상 env fail-closed + 하드 리밋 clamp(삼순 #709 2번) ──
ok("cap: 정상값 '8000' → 8000", resolveQuotaCap("8000") === 8000);
ok("cap: 미설정 → 기본", resolveQuotaCap(undefined) === YT_QUOTA_DAILY_DEFAULT);
ok("cap: 'abc' → 기본(fail-closed)", resolveQuotaCap("abc") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: '0' → 기본", resolveQuotaCap("0") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: '-500' → 기본", resolveQuotaCap("-500") === YT_QUOTA_DAILY_DEFAULT);
ok("cap: 소수 '8000.7' → floor 8000", resolveQuotaCap("8000.7") === 8000);
// 하드 리밋: 10k 초과는 반드시 10k 로 clamp(한도 우회 방지)
ok("hard max 상수 = 10000", YT_QUOTA_HARD_MAX === 10000);
ok("cap: 하드맥스 '10000' → 10000", resolveQuotaCap("10000") === 10000);
ok("cap: '10001' → 10000(clamp)", resolveQuotaCap("10001") === YT_QUOTA_HARD_MAX);
ok("cap: 과대 '99999999' → 10000(clamp, 우회 차단)", resolveQuotaCap("99999999") === YT_QUOTA_HARD_MAX);
ok("cap: '10000000' → 10000(clamp)", resolveQuotaCap("10000000") === YT_QUOTA_HARD_MAX);

// ── getQuotaDate: Pacific 경계 ──────────────────────────────────────
ok(
  "KST 15:00(리셋 전) → Pacific 전날",
  getQuotaDate(new Date("2026-07-19T06:00:00Z")) === "2026-07-18",
);
ok(
  "KST 17:00(리셋 후) → Pacific 당일",
  getQuotaDate(new Date("2026-07-19T08:00:00Z")) === "2026-07-19",
);
ok("YYYY-MM-DD 포맷", /^\d{4}-\d{2}-\d{2}$/.test(getQuotaDate(new Date())));

// ── quotaJobStatus: degrade=warning 교정 ────────────────────────────
ok("정상 → success", quotaJobStatus({ hardErrors: 0, degraded: false }) === "success");
ok("quota degrade → warning(성공 오표기 아님)", quotaJobStatus({ hardErrors: 0, degraded: true }) === "warning");
ok("hardError → error", quotaJobStatus({ hardErrors: 2, degraded: false }) === "error");
ok("hardError+degrade → error 우선", quotaJobStatus({ hardErrors: 1, degraded: true }) === "error");

// ── QuotaCounter: 실제 시도별 units 누적(삼순 #709 2번) ──────────────
ok("units 상수: search=100, videos=1", YT_UNITS_SEARCH === 100 && YT_UNITS_VIDEOS_LIST === 1);
{
  const c = newQuotaCounter();
  ok("counter 초기 0", c.units === 0 && c.searches === 0 && c.videoLists === 0);
  countSearch(c);
  countVideoList(c);
  ok("search1+videoList1 → 101 units", c.units === 101 && c.searches === 1 && c.videoLists === 1);
  countSearch(c);
  ok("search 추가 1회 → 201 units, searches=2", c.units === 201 && c.searches === 2);
  // details 미시도(videoIds 0) 케이스: countVideoList 미호출 → units 미가산
  const c2 = newQuotaCounter();
  countSearch(c2); // search만 시도, details 없음
  ok("search만 시도(details 미시도) → 100 units only", c2.units === 100 && c2.videoLists === 0);
  // counter undefined 안전
  countSearch(undefined);
  countVideoList(undefined);
  ok("counter undefined 무해", true);
}

// ── withQuotaRecording: 모든 종료 경로에서 정확히 1회 durable 기록(삼순 #709 3번) ──
async function testWithQuotaRecording() {
  // (a) 정상 종료: search+videoList → record 1회 101
  const calls: number[] = [];
  const rec = async (u: number) => { calls.push(u); };
  await withQuotaRecording(rec, async (c) => { countSearch(c); countVideoList(c); return "ok"; });
  ok("withQuotaRecording 정상 → record 1회 101", calls.length === 1 && calls[0] === 101);

  // (b) fetch/json fault: countSearch 후 throw → record 1회 100 + 예외 전파(undercount 방지)
  const calls2: number[] = [];
  let threw2 = false;
  try {
    await withQuotaRecording(async (u) => { calls2.push(u); }, async (c) => {
      countSearch(c); // search 100 이미 소비
      throw new Error("fetch/json fault");
    });
  } catch { threw2 = true; }
  ok("withQuotaRecording fetch/json fault → record 1회 100 + rethrow", calls2.length === 1 && calls2[0] === 100 && threw2);

  // (c) details 후 예외: search+videoList(101) 후 throw → record 1회 101 + 예외 전파
  const calls3: number[] = [];
  let threw3 = false;
  try {
    await withQuotaRecording(async (u) => { calls3.push(u); }, async (c) => {
      countSearch(c); countVideoList(c); // 101 소비
      throw new Error("post-details fault");
    });
  } catch { threw3 = true; }
  ok("withQuotaRecording details 후 예외 → record 1회 101 + rethrow", calls3.length === 1 && calls3[0] === 101 && threw3);

  // (d) units=0(시도 없음) → record 미호출
  const calls4: number[] = [];
  await withQuotaRecording(async (u) => { calls4.push(u); }, async () => "no-op");
  ok("withQuotaRecording units=0 → record 미호출", calls4.length === 0);

  // (e) 조기 return(data.error fallback 모사)도 record 1회
  const calls5: number[] = [];
  const r5 = await withQuotaRecording(async (u) => { calls5.push(u); }, async (c) => {
    countSearch(c);
    return "fallback"; // 조기 return
  });
  ok("withQuotaRecording 조기 return → record 1회 100", calls5.length === 1 && calls5[0] === 100 && r5 === "fallback");
}

// ── isQuotaSignal / YouTubeApiError: 구조화 판별(삼순 #709 3번) ───────
ok("429 status → quota(rate)", isQuotaSignal({ status: 429 }) === true);
ok("reason=quotaExceeded → quota", isQuotaSignal({ status: 403, reason: "quotaExceeded" }) === true);
ok("reason=dailyLimitExceeded → quota", isQuotaSignal({ status: 403, reason: "dailyLimitExceeded" }) === true);
ok("reason=rateLimitExceeded → quota", isQuotaSignal({ status: 403, reason: "rateLimitExceeded" }) === true);
ok("reason=userRateLimitExceeded → quota", isQuotaSignal({ reason: "userRateLimitExceeded" }) === true);
ok("403 forbidden(단순 키 오류, reason/문구 없음) → quota 아님", isQuotaSignal({ status: 403, reason: "forbidden" }) === false);
ok("정확 원문 'exceeded your quota' → quota", isQuotaSignal({ message: "The request cannot be completed because you have exceeded your quota." }) === true);
ok("문구 'daily limit' → quota", isQuotaSignal({ message: "Daily Limit Exceeded" }) === true);
ok("무관 에러 → quota 아님", isQuotaSignal({ status: 500, message: "internal error" }) === false);

// YouTubeApiError 는 status/reason 을 quotaInfoFromError 로 보존
{
  const e = new YouTubeApiError("quota exceeded", { status: 403, reason: "quotaExceeded" });
  const info = quotaInfoFromError(e);
  ok("YouTubeApiError → status/reason 보존", info.status === 403 && info.reason === "quotaExceeded");
  ok("보존된 info → isQuotaSignal true", isQuotaSignal(info) === true);
  // 일반 Error 는 message 만
  const info2 = quotaInfoFromError(new Error("something quotaExceeded happened"));
  ok("일반 Error → message만, 문구로 quota 판별", info2.status === undefined && isQuotaSignal(info2) === true);
  // extractYouTubeError: googleapis error body 구조화
  const body = { error: { message: "quota", errors: [{ reason: "quotaExceeded" }] } };
  const ex = extractYouTubeError(403, body);
  ok("extractYouTubeError → message+reason", ex.message === "quota" && ex.reason === "quotaExceeded");
  const exEmpty = extractYouTubeError(500, {});
  ok("extractYouTubeError 빈 body → 기본 메시지", exEmpty.message.includes("HTTP 500") && exEmpty.reason === undefined);
}

// ── reserveQuota: RPC 매핑 + 백스톱 ─────────────────────────────────
type RpcResp = { data: unknown; error: { message: string } | null };
function fakeSb(resp: RpcResp) {
  return { rpc: async () => resp } as unknown as Parameters<typeof reserveQuota>[0];
}
(async () => {
  const allow = await reserveQuota(
    fakeSb({ data: [{ allowed: true, used_after: 400, remaining: 9100 }], error: null }),
    100,
  );
  ok("allowed=true 매핑", allow.allowed === true && allow.remaining === 9100 && allow.used === 400);

  const deny = await reserveQuota(
    fakeSb({ data: [{ allowed: false, used_after: 9500, remaining: 0 }], error: null }),
    100,
  );
  ok("allowed=false(cap 초과) 매핑", deny.allowed === false && deny.remaining === 0);

  // RPC 실패 → 백스톱(allowed=true, ledgerError) — 파이프라인 안 막음
  const err = await reserveQuota(
    fakeSb({ data: null, error: { message: "relation does not exist" } }),
    100,
  );
  ok("RPC 오류 → 백스톱 allowed=true", err.allowed === true && !!err.ledgerError);

  // data 빈 응답 → 백스톱
  const empty = await reserveQuota(fakeSb({ data: [], error: null }), 100);
  ok("빈 응답 → 백스톱 allowed=true", empty.allowed === true && !!empty.ledgerError);

  // ── recordQuota: await/durable + RPC 오류 노출(throw 안 함, 삼순 #709 2번) ──
  let threw = false;
  let errResult;
  try {
    errResult = await recordQuota(fakeSb({ data: null, error: { message: "boom" } }), 100);
  } catch { threw = true; }
  ok("recordQuota는 throw 안 함(best-effort)", !threw);
  ok("recordQuota RPC 오류 → error 노출(삼키지 않음)", !!errResult && errResult.recorded === false && errResult.error === "boom");

  const okRec = await recordQuota(fakeSb({ data: 4321, error: null }), 100);
  ok("recordQuota 성공 → recorded=true + used 반환", okRec.recorded === true && okRec.used === 4321);

  const zero = await recordQuota(fakeSb({ data: null, error: null }), 0);
  ok("recordQuota units<=0 무시 → recorded=false", zero.recorded === false && zero.error === undefined);

  await testWithQuotaRecording();

  console.log(`\n${fail === 0 ? "🟢 ALL PASS" : `🔴 ${fail} FAILED`}`);
  process.exit(fail === 0 ? 0 : 1);
})();
