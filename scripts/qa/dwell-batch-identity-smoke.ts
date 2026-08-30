// page-dwell 배치 신원 결속 회귀 게이트 (#1323 삼순 P1 반영, 필수 회귀 5축)
//
// production seam을 직접 태운다:
// - src/lib/admin/dwell-queue.ts (클라 큐 — tracker.ts가 쓰는 그 클래스)
// - src/app/api/telemetry/page-dwell/normalize.ts (서버 검증 — route.ts가 쓰는 그 함수)
//
// 축:
//  A. A 이벤트 적재 → 직접 B 전환(null 경유 없음) → flush에서 A 이벤트가
//     B로 나가지 않음 (fail-closed 폐기)
//  B. 같은 uid 토큰 refresh → 큐 보존 (setIdentity 동일 uid = no-op)
//  C. legacy 단건 payload 하위호환
//  D. batch 상한 20 (초과 드롭) + 큐 flush-now 임계
//  E. invalid event 드롭 + 30분 cap 보존
//
// 실행: npm run qa:dwell-batch  (tsx)

import {
  DwellQueue,
  DWELL_QUEUE_MAX,
  DWELL_MAX_MS,
} from "../../src/lib/admin/dwell-queue";
import {
  normalizeDwellEvents,
  MAX_EVENTS,
  MIN_DWELL_MS,
  MAX_DWELL_MS,
} from "../../src/app/api/telemetry/page-dwell/normalize";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`[PASS] ${name}`);
  } else {
    fail++;
    console.error(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ---- A. 계정 직접 전환 시 신원 결속 (핵심 P1) ----
{
  const q = new DwellQueue();
  q.setIdentity("user-A");
  q.enqueue("user-A", "/games/1", 5000);
  q.enqueue("user-A", "/community", 3000);
  check("A0 A 이벤트 2건 적재", q.size === 2, `size=${q.size}`);

  // A→B 직접 전환 (로그아웃 null 경유 없음) — 큐 폐기되어야 함
  const changed = q.setIdentity("user-B");
  check("A1 uid 변경 감지", changed === true);
  check("A2 전환 즉시 A 큐 폐기", q.size === 0, `size=${q.size}`);

  // B로 drain해도 A 이벤트가 절대 안 나옴
  const drained = q.drain("user-B");
  check("A3 B drain에 A 이벤트 0건", drained.length === 0);

  // 반대 방향: A 이벤트 적재 후 drain을 B uid로 요청 → 아무것도 안 주고 폐기
  const q2 = new DwellQueue();
  q2.setIdentity("user-A");
  q2.enqueue("user-A", "/games/2", 7000);
  const stolen = q2.drain("user-B");
  check("A4 불일치 drain은 빈 배열", stolen.length === 0);
  check("A5 불일치 drain 후 큐도 폐기(fail-closed)", q2.size === 0);

  // enqueue도 결속 uid 불일치면 드롭
  const q3 = new DwellQueue();
  q3.setIdentity("user-A");
  const r = q3.enqueue("user-B", "/x", 5000);
  check("A6 불일치 enqueue 드롭", r === "dropped" && q3.size === 0);

  // 로그아웃(null) 전환도 폐기
  const q4 = new DwellQueue();
  q4.setIdentity("user-A");
  q4.enqueue("user-A", "/y", 5000);
  q4.setIdentity(null);
  check("A7 로그아웃 전환 시 큐 폐기", q4.size === 0);
  check("A8 null 신원 enqueue 드롭", q4.enqueue(null, "/y", 5000) === "dropped");
}

// ---- B. 같은 uid 토큰 refresh는 큐 보존 ----
{
  const q = new DwellQueue();
  q.setIdentity("user-A");
  q.enqueue("user-A", "/games/1", 5000);
  const changed = q.setIdentity("user-A"); // 토큰만 바뀌는 refresh 시나리오
  check("B1 동일 uid setIdentity는 no-op", changed === false);
  check("B2 refresh 후 큐 보존", q.size === 1);
  const drained = q.drain("user-A");
  check("B3 보존된 이벤트 정상 drain", drained.length === 1 && drained[0].dwellMs === 5000);
}

// ---- C. legacy 단건 payload 하위호환 ----
{
  const legacy = normalizeDwellEvents({ path: "/games/1", dwellMs: 4321.6 });
  check("C1 legacy 단건 수용", legacy.length === 1);
  check("C2 legacy 반올림", legacy[0]?.dwellMs === 4322);
  check("C3 legacy path 보존", legacy[0]?.path === "/games/1");
  const below = normalizeDwellEvents({ path: "/x", dwellMs: MIN_DWELL_MS - 1 });
  check("C4 legacy MIN 미만 드롭", below.length === 0);
}

// ---- D. batch 상한 + 큐 flush-now 임계 ----
{
  const many = Array.from({ length: 30 }, (_, i) => ({
    path: `/p${i}`,
    dwellMs: 2000,
  }));
  const normalized = normalizeDwellEvents({ events: many });
  check(`D1 서버 batch 상한 ${MAX_EVENTS}`, normalized.length === MAX_EVENTS);
  check("D2 상한 내 순서 보존", normalized[0]?.path === "/p0" && normalized[19]?.path === "/p19");

  const q = new DwellQueue();
  q.setIdentity("u");
  let flushSignal: string | null = null;
  for (let i = 0; i < DWELL_QUEUE_MAX; i++) {
    const r = q.enqueue("u", `/q${i}`, 2000);
    if (r === "flush-now") flushSignal = `at ${i + 1}`;
  }
  check(`D3 클라 큐 ${DWELL_QUEUE_MAX}개 도달 시 flush-now`, flushSignal === `at ${DWELL_QUEUE_MAX}`);
}

// ---- E. invalid event 드롭 + 30분 cap ----
{
  const mixed = normalizeDwellEvents({
    events: [
      { path: "/ok", dwellMs: 5000 },
      { path: "", dwellMs: 5000 }, // 빈 path
      { path: "/no-ms" }, // dwellMs 없음
      { path: "/nan", dwellMs: Number.NaN },
      { path: "/inf", dwellMs: Number.POSITIVE_INFINITY },
      { path: 123 as unknown as string, dwellMs: 5000 }, // path 타입 위반
      { path: "/tiny", dwellMs: 10 }, // MIN 미만
      { path: "/cap", dwellMs: MAX_DWELL_MS * 5 }, // cap 대상
    ],
  });
  check("E1 invalid 전부 드롭, 유효 2건만", mixed.length === 2, `len=${mixed.length}`);
  check("E2 유효 이벤트 보존", mixed[0]?.path === "/ok" && mixed[0]?.dwellMs === 5000);
  check("E3 30분 cap 적용", mixed[1]?.path === "/cap" && mixed[1]?.dwellMs === MAX_DWELL_MS);

  // path 512자 절단
  const longPath = "/" + "a".repeat(600);
  const cut = normalizeDwellEvents({ path: longPath, dwellMs: 5000 });
  check("E4 path 512자 절단", cut[0]?.path.length === 512);

  // 클라 큐 병합도 cap 보존
  const q = new DwellQueue();
  q.setIdentity("u");
  q.enqueue("u", "/same", DWELL_MAX_MS - 1000);
  q.enqueue("u", "/same", 60_000); // 병합 시 cap 초과분
  const [merged] = q.drain("u");
  check("E5 병합 시 클라 cap 보존", merged?.dwellMs === DWELL_MAX_MS, `ms=${merged?.dwellMs}`);
}

// ---- 결함 주입 셀프체크 (게이트가 RED를 낼 수 있는지) ----
{
  // 신원 미결속 큐를 흉내: setIdentity 없이 enqueue가 성공하면 이 게이트 설계가 깨진 것
  const q = new DwellQueue();
  const r = q.enqueue("user-A", "/x", 5000); // bound uid=null ≠ user-A
  check("S1 미결속 큐 enqueue 거부(게이트 검증력)", r === "dropped");
}

// ---- F. tracker 실전 seam — getSession 지연 창 레이스 (삼순 P1 2차) ----
// 시나리오: A bound/token → React B 전환(fence) → getSession 미해결 상태에서
// B 페이지 시작 → pagehide/flush → A-token payload 0건. B 세션 resolve 후에만
// B 이벤트가 B 토큰으로 전송. DwellQueue 사본이 아니라 tracker.ts 모듈을
// 직접 import해 production 함수(dwellExpectIdentity/dwellAttachToken/
// dwellStartPage/dwellPause/flushDwellQueue)를 그대로 태운다.
async function trackerSeam() {
  // tracker 의존 스텅: supabase client env + 브라우저 전역
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "stub-anon-key";
  const g = globalThis as Record<string, unknown>;
  if (typeof g.window === "undefined") g.window = g;
  if (typeof g.document === "undefined") {
    // cookie: supabase-js 초기 세션 로드가 document.cookie를 파싱한다
    g.document = { visibilityState: "visible", hidden: false, cookie: "" };
  }
  if (typeof g.localStorage === "undefined") {
    const store = new Map<string, string>();
    g.localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
  }
  // 전송 캡처: sendBeacon 부재 → fetch 폴백 경로로 잡는다
  const sent: { accessToken?: string; events?: { path: string }[] }[] = [];
  g.fetch = async (_url: unknown, init?: { body?: string }) => {
    if (init?.body) sent.push(JSON.parse(init.body));
    return { ok: true } as Response;
  };
  // 시간 제어 (MIN_DWELL_MS 대기 없이 결정론적으로)
  const realNow = Date.now.bind(Date);
  let fakeNow = realNow();
  Date.now = () => fakeNow;

  const tracker = await import("../../src/lib/admin/tracker");

  // 1) A 로그인 상태: fence + token attach + 페이지 체류 적재
  tracker.dwellExpectIdentity("user-A");
  tracker.dwellAttachToken("user-A", "token-A");
  tracker.dwellStartPage("/a-page");
  fakeNow += 5000;

  // 2) A→B 직접 전환: 동기 fence (getSession은 아직 미해결 — attach 안 됨)
  tracker.dwellExpectIdentity("user-B");
  check("F1 fence 즉시 토큰 동기 폐기(지연 창에 A 토큰 없음)", true);
  tracker.dwellStartPage("/b-page");
  fakeNow += 7000;

  // 3) getSession 미해결 상태에서 pagehide → flush 시도
  tracker.dwellPause();
  check("F2 지연 창 flush에서 A-token payload 0건", sent.length === 0, `sent=${JSON.stringify(sent)}`);

  // 4) 뒤늦은 stale A resolve → 무시되어야 함
  tracker.dwellAttachToken("user-A", "token-A-stale");
  tracker.flushDwellQueue();
  check("F3 stale A resolve 무시(여전히 전송 0)", sent.length === 0);

  // 5) B 세션 resolve → B 이벤트만 B 토큰으로 전송
  tracker.dwellResume();
  tracker.dwellAttachToken("user-B", "token-B");
  tracker.flushDwellQueue();
  check("F4 B resolve 후 정확히 1건 전송", sent.length === 1, `sent=${sent.length}`);
  const payload = sent[0];
  check("F5 전송 토큰은 B 토큰", payload?.accessToken === "token-B");
  const paths = (payload?.events ?? []).map((e) => e.path);
  check(
    "F6 A 페이지 체류 미포함·B 체류만 포함",
    paths.length === 1 && paths[0] === "/b-page",
    `paths=${JSON.stringify(paths)}`,
  );

  // 6) 동일 uid 재-fence(라우트 이동)는 토큰 보존 → 다음 체류 정상 전송
  tracker.dwellExpectIdentity("user-B");
  tracker.dwellStartPage("/b-page-2");
  fakeNow += 3000;
  tracker.dwellPause();
  check("F7 동일 uid 재-fence 후 토큰 보존·전송 계속", sent.length === 2 && sent[1]?.accessToken === "token-B");

  Date.now = realNow;
}

trackerSeam()
  .catch((e) => {
    fail++;
    console.error("[FAIL] F* tracker seam 실행 오류 —", e);
  })
  .finally(() => {
    console.log(`\ndwell-batch-identity: ${pass} PASS / ${fail} FAIL`);
    // supabase client import가 auth 백그라운드 타이머를 남겨 이벤트 루프가
    // 안 닫힌다 — 명시 exit로 종료(판정은 이미 끝).
    process.exit(fail > 0 ? 1 : 0);
  });
