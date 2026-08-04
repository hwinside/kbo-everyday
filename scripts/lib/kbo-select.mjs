/**
 * KBO 기록실 드롭다운(시즌·시리즈) 전환 — **확인된 전환만 성공으로 본다**.
 *
 * ── 배경(2026-08-04, 삼순 6차 지적) ──
 * 페이지 순회는 fail-close 로 고쳤는데 select 전환은 양쪽 다 무확인 통과였다.
 *
 *  - oracle(`collectKboPages`): 16회 polling 동안 표가 안 바뀌어도 그냥 루프를 빠져나가
 *    **이전 시즌 행**으로 수집을 계속했다. fake 2025→2026 postback 유실에서
 *    OLD-SEASON 행을 정상 반환하는 것을 재현했다.
 *  - crawler(`changeSelectAndWait`): `waitForFunction` 타임아웃을 catch 한 뒤
 *    고정 대기만 하고 확인 없이 진행했다.
 *
 * 이게 왜 치명적이냐면, 이건 "몇 행 유실"이 아니라 **데이터셋 전체가 다른 시즌**이 된다.
 * 게다가 oracle 이 2025 를 원본으로 삼으면 전 필드 대조가 통째로 뒤집힌다
 * (2026 산출물 전체가 불일치로 뜨거나, 최악은 2025 산출물이 정상으로 승인된다).
 *
 * ── 계약 ──
 *  1) 전환 성공의 1차 근거는 **select 의 실제 값**이다.
 *     postback 유실이면 값 자체가 목표로 안 바뀐다 — 표 내용보다 정확하고,
 *     "시즌이 달라도 첫 화면이 우연히 같은" 경우에 false RED 를 내지 않는다.
 *  2) 값이 목표로 바뀐 뒤 표가 실제로 교체될 때까지 기다린다(값만 먼저 반영되는 경우 대비).
 *     단, 값이 맞는데 표가 그대로인 상황은 "같은 데이터"일 수 있으므로 실패로 보지 않는다.
 *  3) bounded 재시도 후에도 값이 목표가 아니면 **던진다**. 무확인 진행은 하지 않는다.
 */

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_POLLS = 16;
const DEFAULT_POLL_INTERVAL_MS = 500;

/**
 * @param {object} io
 * @param {() => Promise<string|null>} io.readValue 현재 select 값
 * @param {(value: string) => Promise<void>} io.select 값 선택(postback 유발)
 * @param {() => Promise<string>} io.tableSignature 현재 표 시그니처
 * @param {(ms: number) => Promise<void>} io.sleep
 */
export async function selectAndConfirm(io, value, {
  label = "select",
  attempts = DEFAULT_ATTEMPTS,
  polls = DEFAULT_POLLS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  const target = String(value);
  const initial = await io.readValue();
  if (initial === target) return { changed: false };

  const before = await io.tableSignature();

  for (let attempt = 0; attempt < attempts; attempt++) {
    await io.select(target);

    for (let poll = 0; poll < polls; poll++) {
      await io.sleep(pollIntervalMs);
      const now = await io.readValue();
      if (now !== target) continue; // 아직 postback 반영 전(또는 유실)

      // ⚠︎ 값이 target 인 것만으로는 부족하다.
      // Playwright `selectOption()` 은 서버 postback 이 끝나기 전에 이미 DOM select 값을
      // target 으로 바꾼다. 그래서 postback/표 갱신이 유실되면
      // **"selector 는 2026 인데 표는 2025"** 상태가 실제로 만들어진다.
      // 종전 판은 이 상태를 `{changed:true, settled:false}` 로 정상 승인했다(삼순 8차 지적).
      // 전환이 필요했던 경우에는 값 + 표 교체가 **둘 다** 성공 조건이다.
      for (let settle = 0; settle < polls; settle++) {
        const signature = await io.tableSignature();
        if (signature && signature !== before) return { changed: true, settled: true };
        await io.sleep(pollIntervalMs);
      }
      // 값만 바뀌고 표가 끝내 그대로다 → 다음 attempt 에서 재시도한다.
      break;
    }
  }

  const finalValue = await io.readValue();
  throw new Error(
    `source_season_transition_incomplete: ${label} 전환이 확인되지 않았다`
    + `(목표 "${target}", 현재 값 "${finalValue}", 재시도 ${attempts}회 소진)`
    + " — selector 값만 바뀌고 표가 그대로면 지난 조건의 데이터를 정본으로 읽는다",
  );
}

/** Playwright page → selectAndConfirm 어댑터. */
export function createSelectAdapter(page, selector, tableSignature) {
  return {
    readValue: () => page.$eval(selector, (el) => el.value).catch(() => null),
    select: async (value) => {
      await page.selectOption(selector, value).catch(() => {});
      await page.waitForLoadState("networkidle").catch(() => {});
    },
    tableSignature,
    sleep: (ms) => page.waitForTimeout(ms),
  };
}
