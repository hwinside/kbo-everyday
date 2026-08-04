/**
 * KBO 기록실 페이지네이션 — 전 페이지 완주 계약.
 *
 * 배경(2026-08-04):
 *  - 종전에는 클릭 후 고정 1,200ms 만 기다리고 무조건 다음 페이지로 간주했다.
 *    KBO 응답이 느리면 이전 화면을 다시 읽고("0 new") 페이지 번호만 올라가,
 *    그 페이지는 통째로 유실됐다. 실측 피해: 타자 329→299(30행), 수비 823→30.
 *  - 수비에는 스냅샷 가드조차 없어 96% 유실이 조용히 파일에 써졌다.
 *
 * 계약:
 *  1) 클릭 후 테이블이 *실제로* 교체될 때까지 기다린다.
 *  2) 교체되지 않으면 즉시 죽지 않고 **bounded 재클릭 retry** 한다
 *     (일시적 지연에 게이트가 매일 터지면, 게이트가 스스로 정지 사고를 만든다).
 *  3) retry 를 다 쓰고도 교체되지 않으면 `page_advance_failed` 로 죽는다.
 *     불완전 수집을 성공으로 넘기면 뒤의 어떤 검증도 의미가 없다.
 *  4) 이미 본 페이지를 다시 만나면(stale 재렌더) 그것도 실패다.
 *
 * 순수 로직으로 분리해 Playwright 없이 행동을 검증할 수 있게 한다.
 */

const DEFAULT_MAX_PAGES = 60;
const DEFAULT_SWAP_ATTEMPTS = 16;
const DEFAULT_SWAP_INTERVAL_MS = 500;
const DEFAULT_RETRIES = 2;

/** 행 배열 → 페이지 식별 시그니처. */
export function signatureOf(rows) {
  return rows.map((r) => (r.texts || []).join("\u0001")).join("\u0002");
}

/**
 * @param {object} io
 * @param {() => Promise<Array>} io.scrapeTable 현재 테이블 행
 * @param {(pageText: string) => Promise<boolean>} io.clickPage 해당 번호 버튼 클릭(없으면 false)
 * @param {() => Promise<boolean>} io.clickNextGroup 다음 페이지 그룹 클릭(없으면 false)
 * @param {() => Promise<string>} io.pagerSignature 페이저 상태(그룹 전환 판정용)
 * @param {(ms: number) => Promise<void>} io.sleep
 */
export async function collectAllPages({
  scrapeTable,
  clickPage,
  clickNextGroup,
  pagerSignature,
  sleep,
  log = () => {},
  maxPages = DEFAULT_MAX_PAGES,
  swapAttempts = DEFAULT_SWAP_ATTEMPTS,
  swapIntervalMs = DEFAULT_SWAP_INTERVAL_MS,
  retries = DEFAULT_RETRIES,
}) {
  const allRows = [];
  const seenRowSignatures = new Set();
  const seenPageSignatures = new Set();
  let pageNum = 1;

  /** 테이블이 previous 와 달라질 때까지 대기. 안 바뀌면 null. */
  const waitForSwap = async (previous) => {
    for (let i = 0; i < swapAttempts; i++) {
      await sleep(swapIntervalMs);
      const rows = await scrapeTable();
      const signature = signatureOf(rows);
      if (signature && signature !== previous) return { rows, signature };
    }
    return null;
  };

  while (pageNum <= maxPages) {
    const rows = await scrapeTable();
    if (rows.length === 0) break;

    const pageSig = signatureOf(rows);
    if (seenPageSignatures.has(pageSig)) {
      throw new Error(
        `page_advance_failed: page ${pageNum} 가 이미 수집한 화면과 동일 — stale 재렌더(수집 불완전)`,
      );
    }
    seenPageSignatures.add(pageSig);

    const fresh = rows.filter((r) => {
      const sig = `${(r.texts || []).join("\u0001")}\u0002${(r.hrefs || []).join("\u0001")}`;
      if (seenRowSignatures.has(sig)) return false;
      seenRowSignatures.add(sig);
      return true;
    });
    allRows.push(...fresh);
    log(`    Page ${pageNum}: ${rows.length} rows (${fresh.length} new, total: ${allRows.length})`);

    // ── 같은 그룹 안의 다음 페이지 ──
    let advanced = false;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const clicked = await clickPage(String(pageNum + 1));
      if (!clicked) break; // 이 그룹에 다음 번호가 없다 → 그룹 전환으로
      const swapped = await waitForSwap(pageSig);
      if (swapped) { advanced = true; break; }
      if (attempt < retries) {
        log(`    ⟳ page ${pageNum} → ${pageNum + 1} 전환 지연, 재시도 ${attempt + 1}/${retries}`);
      }
    }
    if (advanced) { pageNum++; continue; }

    // 다음 번호 버튼이 있었는데도 끝내 전환되지 않았다면 실패다.
    if (await clickPage(String(pageNum + 1))) {
      throw new Error(
        `page_advance_failed: page ${pageNum} → ${pageNum + 1} 전환 실패(재시도 ${retries}회 소진) — 수집 불완전`,
      );
    }

    // ── 페이지 그룹 전환 ──
    const beforePager = await pagerSignature();
    const hasNextGroup = await clickNextGroup();
    if (!hasNextGroup) break;

    const groupSwapped = await waitForSwap(pageSig);
    const afterPager = await pagerSignature();

    // 페이저가 그대로면 마지막 그룹 — 정상 종료.
    if (!afterPager || afterPager === beforePager) break;
    if (!groupSwapped) {
      throw new Error(
        "page_advance_failed: 페이지 그룹 전환 후에도 테이블이 그대로 — 수집 불완전",
      );
    }
    pageNum++;
  }

  return allRows;
}
