/**
 * 커뮤니티 피드 뒤로가기 복원 회귀.
 *
 * 사고: 피드를 깊게 스크롤한 뒤 글 상세로 들어갔다가 뒤로 나오면 피드가 맨 위로 초기화.
 * production 실측(390x844): scrollY 12849 → 1243, 카드 31 → 11.
 *
 * 핵심 계약(이 스위트가 고정):
 *  ① 스크롤만 저장해서는 못 고친다 — 페이지 수(pageCount)를 함께 복원해야 문서가 충분히 길어진다.
 *  ② 복원은 **뒤로가기(popstate)** 에서만. 탭바 등 push 진입에서는 발동하지 않는다.
 *  ③ 복원 상태는 1회용. TTL 경과·손상된 값은 무시(fail-safe).
 */
import assert from "node:assert/strict";
import {
  parseRestoreState,
  RESTORE_TTL_MS,
  type FeedRestoreState,
} from "../../src/lib/community/feed-restore";

let pass = 0;
let fail = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.error(`  ✗ ${name}\n    ${(e as Error).message}`);
  }
}

const NOW = 1_700_000_000_000;
const ok: FeedRestoreState = { pageCount: 4, scrollY: 12849, savedAt: NOW };

console.log("\n[1] 저장 상태 파싱 — fail-safe");
t("정상 값은 그대로 파싱", () => {
  assert.deepEqual(parseRestoreState(JSON.stringify(ok), NOW), ok);
});
t("null/빈 값은 null", () => {
  assert.equal(parseRestoreState(null, NOW), null);
  assert.equal(parseRestoreState("", NOW), null);
});
t("JSON 파싱 실패는 null(throw 금지)", () => {
  assert.equal(parseRestoreState("{not json", NOW), null);
});
t("TTL 경과분은 무시", () => {
  const stale = JSON.stringify({ ...ok, savedAt: NOW - RESTORE_TTL_MS - 1 });
  assert.equal(parseRestoreState(stale, NOW), null);
});
t("TTL 경계 이내는 유효", () => {
  const edge = JSON.stringify({ ...ok, savedAt: NOW - RESTORE_TTL_MS + 1 });
  assert.notEqual(parseRestoreState(edge, NOW), null);
});
t("음수 scrollY / pageCount<1 / 비수치는 거부", () => {
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, scrollY: -5 }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, pageCount: 0 }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, pageCount: "4" }), NOW), null);
  assert.equal(parseRestoreState(JSON.stringify({ ...ok, savedAt: NaN }), NOW), null);
});

/**
 * [2] 복원 시뮬레이션 — useUnifiedFeed 초기 로드 루프의 계약을 순수 재현한다.
 * 실제 훅과 같은 규칙: saved.pageCount 까지 순차 loadPage, 빈 응답이면 중단, dedupe 유지.
 */
function simulateInitialLoad(opts: {
  totalRows: number;
  pageSize: number;
  saved: FeedRestoreState | null;
}): { loadedRows: number; pages: number; calls: number } {
  const { totalRows, pageSize, saved } = opts;
  let calls = 0;
  const loadPage = (cursor: number | null): number[] => {
    calls++;
    const start = cursor === null ? 0 : cursor;
    return Array.from({ length: Math.max(0, Math.min(pageSize, totalRows - start)) }, (_, i) => start + i + 1);
  };

  const rows = loadPage(null);
  const acc: number[] = [...rows];
  let cursor = rows.length ? rows[rows.length - 1] : null;
  let more = rows.length === pageSize;
  let pages = 1;

  while (saved && more && pages < saved.pageCount) {
    const next = loadPage(cursor);
    if (!next.length) {
      more = false;
      break;
    }
    const seen = new Set(acc);
    next.filter((r) => !seen.has(r)).forEach((r) => acc.push(r));
    cursor = next[next.length - 1];
    more = next.length === pageSize;
    pages += 1;
  }
  return { loadedRows: acc.length, pages, calls };
}

console.log("\n[2] 복원 로드 — 페이지 분량까지 채움");
t("사고 재현: 복원 없으면 1페이지(20건)만 → 문서가 짧아 스크롤 복원 불가", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: null });
  assert.equal(r.pages, 1);
  assert.equal(r.loadedRows, 20);
});
t("복원 시 저장된 페이지 수(4)만큼 채움 = 80건", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: ok });
  assert.equal(r.pages, 4);
  assert.equal(r.loadedRows, 80);
});
t("데이터가 저장 시점보다 적어도 안전하게 멈춤(무한루프 없음)", () => {
  const r = simulateInitialLoad({ totalRows: 25, pageSize: 20, saved: { ...ok, pageCount: 9 } });
  assert.equal(r.loadedRows, 25);
  assert.ok(r.pages <= 9);
  assert.ok(r.calls <= 9, `calls=${r.calls}`);
});
t("복원 페이지 수만큼만 부르고 그 이상 안 부름(과다 요청 방지)", () => {
  const r = simulateInitialLoad({ totalRows: 500, pageSize: 20, saved: ok });
  assert.equal(r.calls, 4);
});

console.log("\n[3] 뒤로가기에서만 복원 (push 진입 격리)");
/** consumeBackNavigation + readFeedRestore 조합 계약을 재현. */
function shouldRestore(cameBack: boolean, savedRaw: string | null, now = NOW) {
  return cameBack ? parseRestoreState(savedRaw, now) : null;
}
t("popstate(뒤로가기) + 저장분 있음 → 복원", () => {
  assert.notEqual(shouldRestore(true, JSON.stringify(ok)), null);
});
t("push 진입(탭바 등)은 저장분이 있어도 복원 안 함", () => {
  assert.equal(shouldRestore(false, JSON.stringify(ok)), null);
});
t("뒤로가기여도 저장분 없으면 복원 안 함", () => {
  assert.equal(shouldRestore(true, null), null);
});

console.log("\n[4] 저장 규칙");
t("1페이지 + 최상단이면 저장할 게 없음(불필요한 복원 방지)", () => {
  // saveFeedRestore 의 조기 반환 조건과 동일한 판정.
  const shouldSkip = (pageCount: number, scrollY: number) => pageCount <= 1 && scrollY <= 0;
  assert.equal(shouldSkip(1, 0), true);
  assert.equal(shouldSkip(1, 500), false);
  assert.equal(shouldSkip(3, 0), false);
});

console.log("\n[5] 실측으로 잡은 회귀 — 저장 시 scrollY 0 덮어쓰기 금지");
/**
 * 사고의 진짜 원인이었다: 상세로 이동할 때 브라우저가 먼저 스크롤을 0으로 되돌린 뒤
 * 피드가 언마운트되므로, 언마운트 시점에 무조건 저장하면 방금 기록한 진짜 위치를 0이 덮어쓴다.
 * (실측: saved scrollY 12972 → 0 → 복원해도 항상 맨 위)
 */
function persistPolicy(prevSaved: number, currentY: number): number {
  // 구현과 동일한 규칙: y<=0 이면 저장 자체를 하지 않는다.
  if (currentY <= 0) return prevSaved;
  return currentY;
}
t("언마운트 시 scrollY 0 은 기존 저장값을 덮어쓰지 않음", () => {
  assert.equal(persistPolicy(7107, 0), 7107);
});
t("정상 스크롤 값은 갱신", () => {
  assert.equal(persistPolicy(7107, 9200), 9200);
});

console.log("\n[6] 뒤로가기 판별 — 전체 문서 로드(back_forward)도 인정");
/** 모바일 웹뷰/전체 로드 복귀에서는 popstate 리스너가 없다(JS 컨텍스트 초기화). */
function cameBack(popFlag: boolean, navType: string): boolean {
  return popFlag || navType === "back_forward";
}
t("SPA popstate 로 복귀", () => assert.equal(cameBack(true, "navigate"), true));
t("전체 로드 뒤로가기(back_forward)도 복원 대상", () => assert.equal(cameBack(false, "back_forward"), true));
t("일반 진입(navigate)은 복원 안 함", () => assert.equal(cameBack(false, "navigate"), false));

console.log(`\nPASS=${pass} FAIL=${fail}`);
process.exit(fail === 0 ? 0 : 1);
