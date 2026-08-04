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
    if (rows.length === 0) return allRows; // 빈 테이블 = 더 볼 페이지 없음

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
    //
    // ⚠︎ 종전에는 그룹 클릭이 수락(true)돼도 pager/table 이 그대로면 재시도 없이 break 했다.
    // 그래서 DOM 전환이 유실되면 "마지막 그룹"으로 오인해 조용히 EOF 로 끝났다.
    // 삼순 실증: 11페이지 fake 에서 그룹 클릭은 수락됐는데 전환이 유실되자
    // 예외 없이 329행 중 300행만 정상 반환했다(= 30행 유실을 성공으로 보고).
    // 이제 그룹 전환도 bounded retry 하고, 소진되면 EOF 가 아니라 실패다.
    const beforePager = await pagerSignature();
    let groupAdvanced = false;
    let groupClickAccepted = false;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const hasNextGroup = await clickNextGroup();
      if (!hasNextGroup) break; // 다음 그룹이 실제로 없다 → 정상 EOF 후보
      groupClickAccepted = true;

      const groupSwapped = await waitForSwap(pageSig);
      const afterPager = await pagerSignature();

      // 클릭이 수락됐는데 pager 도 table 도 안 변했다 = 전환 유실. 재시도한다.
      if (groupSwapped && afterPager && afterPager !== beforePager) {
        groupAdvanced = true;
        break;
      }
      if (attempt < retries) {
        log(`    ⟳ page group 전환 지연, 재시도 ${attempt + 1}/${retries}`);
      }
    }

    if (groupAdvanced) { pageNum++; continue; }

    // 클릭이 한 번이라도 수락됐다면 다음 그룹이 존재한다는 뜻이다.
    // 그런데 끝내 전환되지 않았으므로 EOF 가 아니라 수집 실패다.
    if (groupClickAccepted) {
      throw new Error(
        `source_pagination_incomplete: page ${pageNum} 이후 그룹 전환 실패`
          + `(재시도 ${retries}회 소진) — 남은 페이지를 수집하지 못했다`,
      );
    }

    // 다음 그룹 버튼 자체가 없다 → 정상 완주.
    return allRows;
  }

  // maxPages 소진은 "정상 종료"가 아니다. 남은 페이지가 있는데 멈춘 것이므로 실패다.
  throw new Error(
    `source_pagination_incomplete: maxPages(${maxPages}) 소진 — 남은 페이지를 수집하지 못했다`,
  );

}

/**
 * Playwright page → collectAllPages 어댑터.
 *
 * ⚠︎ 어댑터를 크롤러 안에 인라인으로 두면, `clickNextGroup` 을 `() => false` 로 바꿔도
 * 스모크가 문자열만 보므로 GREEN 이었다(삼순 지적). 여기로 빼서 fake page 로 직접 태운다.
 */
export function createKboPageAdapter(page) {
  return {
    scrapeTable: () => page.$$eval("tbody tr", (rows) =>
      rows.map((tr) => {
        const cells = [...tr.querySelectorAll("td")];
        return {
          texts: cells.map((td) => td.textContent.trim()),
          hrefs: cells.map((td) => {
            const a = td.querySelector("a");
            return a ? a.getAttribute("href") : "";
          }),
        };
      }),
    ),
    clickPage: async (targetPageText) => {
      const btn = await page.locator('a[id*="ucPager_btnNo"]').filter({ hasText: targetPageText }).first();
      if (!(await btn.count())) return false;
      await btn.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      return true;
    },
    clickNextGroup: async () => {
      const btn = await page.$('a[id$="btnNext"]');
      if (!btn) return false;
      await btn.click();
      await page.waitForLoadState("networkidle").catch(() => {});
      return true;
    },
    pagerSignature: () =>
      page.$$eval('a[id*="ucPager_btnNo"]', (links) =>
        links.map((a) => `${a.textContent?.trim()}:${a.className}`).join("|"),
      ),
    sleep: (ms) => page.waitForTimeout(ms),
  };
}
