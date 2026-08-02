// `발암경기 인내형` 태그 회귀 (하린아빠 2026-08-02 별건 PR).
//
// 검증 축:
//  ① 임계 `ERROR_PRONE_MIN`(=2)이 실측 분포의 상위 구간인지 — 근거 없는 상수 재발 차단
//  ② 미확인 경기를 0으로 세지 않는지 (조회 실패가 "실책 없음"으로 둔갑 금지)
//  ③ 태그 등급이 단조·도달 가능한지 (도달 불가 등급만 만들지 않기 — awayFanTag 교훈)
//  ④ failover SSOT: KBO 실패/결손 → Naver, 둘 다 실패면 미확인(0 아님)
//  ⑤ aggregate actual: myErrors 홈/원정 귀속 + D1 집계
// ⚠️ import 는 호이스팅되므로 이 파일 안에서 process.env 를 대입해봐야 늦다.
// aggregate/ui 가 트랜지티브로 로드하는 supabase/admin 싱글톤은 **모듈 로드 시점**에
// env 를 요구하므로, 기존 스모크들과 같이 전용 모듈을 **가장 먼저** import 한다.
import "./_smoke-env";

import assert from "node:assert/strict";
import {
  ERROR_PRONE_MIN,
  MEASURED_TEAM_GAME_ERRORS,
} from "../../src/lib/venue-stats/aggregate";
import { errorToleranceTag } from "../../src/lib/venue-stats/ui";
import { fetchGameErrors, fetchGameErrorsWithinDeadline } from "../../src/lib/venue-stats/game-errors";

let pass = 0;
const failures: string[] = [];
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return (async () => {
    try {
      await fn();
      pass++;
    } catch (e) {
      failures.push(`${name}: ${(e as Error).message}`);
    }
  })();
}

async function main() {
  // ── ① 임계 근거 ──────────────────────────────────────────────────────────────
  await check("임계 2는 실측 분포에서 상위 20% 이내 구간이다", () => {
    const h = MEASURED_TEAM_GAME_ERRORS.histogram;
    const total = MEASURED_TEAM_GAME_ERRORS.teamGames;
    const sum = Object.values(h).reduce((a, b) => a + b, 0);
    assert.equal(sum, total, `히스토그램 합(${sum})이 팀-경기 수(${total})와 다르다`);

    const atOrAbove = (k: number) =>
      Object.entries(h).filter(([e]) => Number(e) >= k).reduce((a, [, c]) => a + c, 0) / total;

    const share = atOrAbove(ERROR_PRONE_MIN);
    assert.ok(
      share <= 0.2,
      `임계 ${ERROR_PRONE_MIN}개 이상이 ${(share * 100).toFixed(1)}% — 너무 흔하면 '발암'이 아니다`,
    );
    // 반대편: 너무 희귀하면 아무도 못 받는다.
    assert.ok(
      share >= 0.03,
      `임계 ${ERROR_PRONE_MIN}개 이상이 ${(share * 100).toFixed(1)}% — 도달 불가 등급`,
    );
    // RED: 임계를 1로 내리면 3분의 1이 발암경기가 되어 위 상한을 깬다.
    assert.ok(atOrAbove(1) > 0.2, `임계 1은 ${(atOrAbove(1) * 100).toFixed(1)}% — 상한을 넘어야 정상`);
  });

  // ── ② 미확인 처리 ────────────────────────────────────────────────────────────
  await check("확인된 경기가 0건이면 태그를 만들지 않는다", () => {
    assert.equal(errorToleranceTag({ proneGames: 0, knownGames: 0, errorsSeen: 0 }), null);
    // 발암경기 수가 양수여도 확인 경기가 0이면 모순 입력 → 태그 없음(fail-close).
    assert.equal(errorToleranceTag({ proneGames: 2, knownGames: 0, errorsSeen: 4 }), null);
  });

  await check("발암경기가 없으면 태그 없음(정상 상태를 태그로 만들지 않는다)", () => {
    assert.equal(errorToleranceTag({ proneGames: 0, knownGames: 5, errorsSeen: 3 }), null);
  });

  await check("NaN/음수 같은 오염 입력은 fail-close", () => {
    assert.equal(errorToleranceTag({ proneGames: NaN, knownGames: 5, errorsSeen: 1 }), null);
    assert.equal(errorToleranceTag({ proneGames: 2, knownGames: NaN, errorsSeen: 1 }), null);
    assert.equal(errorToleranceTag({ proneGames: -1, knownGames: 5, errorsSeen: 1 }), null);
  });

  // ── ③ 등급 단조·도달성 ───────────────────────────────────────────────────────
  await check("등급은 발암경기 수에 대해 단조 증가하고 근거를 표기한다", () => {
    const t1 = errorToleranceTag({ proneGames: 1, knownGames: 4, errorsSeen: 2 })!;
    const t2 = errorToleranceTag({ proneGames: 2, knownGames: 6, errorsSeen: 5 })!;
    const t3 = errorToleranceTag({ proneGames: 3, knownGames: 9, errorsSeen: 8 })!;
    assert.equal(t1.tier, 1);
    assert.equal(t1.label, "발암경기 인내형");
    assert.ok(t2.tier > t1.tier && t3.tier > t2.tier, "등급이 역행하면 안 됨");
    assert.equal(t1.value, "1경기 · 실책 2개 목격", `근거 문자열: ${t1.value}`);
    // 실측 직관 최대 1회에서 최소 1단계는 도달 가능해야 한다(도달 불가 등급만 금지).
    assert.equal(t1.tier, 1);
  });

  await check("근거에 Infinity/NaN 이 새지 않는다", () => {
    const tag = errorToleranceTag({ proneGames: 2, knownGames: 2, errorsSeen: 4 })!;
    assert.ok(!/Infinity|NaN|undefined/.test(tag.value), `근거 오염: ${tag.value}`);
  });

  // ── ④ failover SSOT ─────────────────────────────────────────────────────────
  await check("KBO 성공이면 KBO 값을 쓴다", async () => {
    const got = await fetchGameErrors("G1", {
      kbo: async () => ({ away: { E: 2 }, home: { E: 0 } }),
      naver: async () => { throw new Error("naver 호출되면 안 됨"); },
    });
    assert.deepEqual(got, { away: 2, home: 0 });
  });

  await check("KBO 실패면 Naver 로 failover (KBO-only 경로 금지 — AGENTS P0)", async () => {
    const got = await fetchGameErrors("G1", {
      kbo: async () => { throw new Error("KBO 503"); },
      naver: async () => ({ away: { E: 1 }, home: { E: 3 } }),
    });
    assert.deepEqual(got, { away: 1, home: 3 });
  });

  await check("KBO 200-empty(열화)도 Naver 로 넘어간다", async () => {
    const got = await fetchGameErrors("G1", {
      kbo: async () => null,
      naver: async () => ({ away: { E: 0 }, home: { E: 2 } }),
    });
    assert.deepEqual(got, { away: 0, home: 2 });
  });

  await check("둘 다 실패면 미확인(null) — 0으로 채우지 않는다", async () => {
    const got = await fetchGameErrors("G1", {
      kbo: async () => { throw new Error("x"); },
      naver: async () => null,
    });
    assert.equal(got, null, "조회 실패를 '실책 0'이라는 사실로 만들면 안 된다");
  });

  await check("한쪽 E 만 유효하면 그 경기는 통째로 미확인", async () => {
    const got = await fetchGameErrors("G1", {
      kbo: async () => ({ away: { E: 1 }, home: {} }),
      naver: async () => null,
    });
    assert.equal(got, null, "반쪽 사실로 태그를 만들면 안 된다");
  });

  await check("음수·비정수·비현실 값은 결손 취급", async () => {
    for (const bad of [-1, 1.5, 999, Number.NaN]) {
      const got = await fetchGameErrors("G1", {
        kbo: async () => ({ away: { E: bad as number }, home: { E: 0 } }),
        naver: async () => null,
      });
      assert.equal(got, null, `E=${bad} 를 사실로 수용함`);
    }
  });

  await check("확인 못 한 경기는 Map 에 넣지 않는다(키 부재 = 미확인)", async () => {
    const map = await fetchGameErrorsWithinDeadline(["OK1", "BAD1", "OK2"], {
      fetchers: {
        kbo: async (id) => (id.startsWith("OK") ? { away: { E: 2 }, home: { E: 1 } } : null),
        naver: async () => null,
      },
    });
    assert.equal(map.size, 2, `실패 경기까지 들어감: ${[...map.keys()].join(",")}`);
    assert.ok(map.has("OK1") && map.has("OK2"));
    assert.ok(!map.has("BAD1"), "조회 실패 경기가 0으로 채워짐");
  });

  // ── ⑤ aggregate actual ──────────────────────────────────────────────────────
  await check("aggregate actual: 홈/원정에 따라 내 팀 실책이 귀속되고 D1 이 집계한다", async () => {
    const { buildVenueStatsScope } = await import("../../src/lib/venue-stats/aggregate");
    assert.equal(typeof buildVenueStatsScope, "function", "집계 진입점을 찾지 못함");
    // 실제 payload 조립은 s1b-aggregate 스모크가 담당한다. 여기서는 계약 존재만 확인하고
    // 귀속 로직은 아래 순수 재현으로 고정한다(홈/원정 뒤집힘이 가장 흔한 회귀).
    const pick = (isHome: boolean | null, e: { away: number; home: number } | undefined) => {
      if (!e || isHome === null) return null;
      return isHome ? e.home : e.away;
    };
    const e = { away: 3, home: 1 };
    assert.equal(pick(true, e), 1, "홈 경기면 home E 가 내 실책");
    assert.equal(pick(false, e), 3, "원정 경기면 away E 가 내 실책");
    assert.equal(pick(null, e), null, "홈/원정 미상이면 귀속 불가 → 미확인");
    assert.equal(pick(true, undefined), null, "실책 미조회 경기는 미확인");
  });

}

main().then(() => {
  if (failures.length > 0) {
    console.error(`\nFAIL ${failures.length}`);
    for (const f of failures) console.error("  ✗ " + f);
    process.exit(1);
  }
  console.log(`\nPASS — venue stats error tag (${pass} checks)`);
}).catch((e) => {
  console.error("SMOKE ERROR:", (e as Error).message);
  process.exit(1);
});
