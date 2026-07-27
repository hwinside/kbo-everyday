// 회귀: 도루/도루실패(러너 부문) 0 오표기 방지
// 배경: KBO 러너 페이지는 SB_CN 정렬 1페이지(30행)만 fetch 가능(Vercel 서버리스=Playwright 불가).
//       30위권 밖 선수는 라이브 러너맵에 없어 sb/cs가 0으로 표기되던 버그(김도영 도루 6→0 등).
//       라이브에 없으면 일일 크롤 static JSON의 sb/cs로 폴백해 0 표기를 차단한다.
import assert from "node:assert";
import test from "node:test";
import { resolveRunnerStat } from "../../src/app/api/stats/route";

test("라이브 러너값이 있으면 실시간값 우선(폴백 무시)", () => {
  const r = resolveRunnerStat({ sb: 34, cs: 3 }, { sb: 30, cs: 2 });
  assert.deepStrictEqual(r, { sb: 34, cs: 3 });
});

test("라이브 top30 밖(러너 미존재) → static 일일값으로 폴백(0 방지)", () => {
  // 김도영 케이스: 라이브 러너맵에 없음, static sb=6/cs=1
  const r = resolveRunnerStat(undefined, { sb: 6, cs: 1 });
  assert.deepStrictEqual(r, { sb: 6, cs: 1 });
  assert.notStrictEqual(r.sb, 0, "폴백이 있으면 도루가 0으로 떨어지면 안 됨");
});

test("라이브 실시간값 0(예: 시즌초)은 그대로 존중 — 러너맵에 존재하면 폴백 안 함", () => {
  const r = resolveRunnerStat({ sb: 0, cs: 0 }, { sb: 6, cs: 1 });
  assert.deepStrictEqual(r, { sb: 0, cs: 0 });
});

test("라이브·static 모두 없으면 0", () => {
  const r = resolveRunnerStat(undefined, undefined);
  assert.deepStrictEqual(r, { sb: 0, cs: 0 });
});

test("부분 폴백: 라이브 우선이면 라이브의 cs=0도 존중", () => {
  const r = resolveRunnerStat({ sb: 12, cs: 0 }, { sb: 5, cs: 4 });
  assert.deepStrictEqual(r, { sb: 12, cs: 0 });
});
