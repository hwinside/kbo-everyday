/**
 * Regression smoke for `tallyHitsFromRelays` (2026-05-27).
 *
 * Why
 * ---
 * `naver-relay-counts.ts` enriches Naver record-API batter rows with
 * h2b/h3b/hr because the record API leaves those nulls during a live game.
 * The previous implementation:
 *   1. Filtered `relay.titleStyle !== "8"` → skipped every 대타/대주자/대수비
 *      row (those typically come with `titleStyle="2"`).
 *   2. Extracted batter from `relay.title` via `/번타자\s+(.+)/`. On 비표준
 *      titles like `"대타 문정빈"` the regex missed → fell back to
 *      `relay.title.trim()` → stored counts under the key `"대타 문정빈"` (not
 *      `"문정빈"`). The downstream record-API lookup is keyed by clean player
 *      name → miss → game-detail returns `문정빈 hits=1, h3b=0` → BoxScore-diff
 *      celebration mints a `at_bat_hit` (single) for what was actually a
 *      3루타.
 *
 * Real prod row (2026-05-27 LG-LT, 문정빈 7회초 3루타):
 *   `/_celeb/hit/20260527LGLT0`, `source=kbo_diff`,
 *   `eventId=...at_bat_hit-7-T-문정빈-1`.
 *
 * Fix: parseInningRelays(game-relay/route.ts)와 동일 패턴으로 전환 — batter는
 * `opt.text` parts[0] (= `"문정빈 : ..."`)에서 추출, `titleStyle` 필터 제거,
 * " : " 분리자 없는 row는 skip.
 *
 * Assertions
 * ----------
 *   T1: [P0 회귀] title="대타 문정빈", titleStyle="2", text="문정빈 : ... 3루타"
 *       → counts.get("문정빈").h3b === 1.
 *   T2: [기존 회귀] title="3번타자 홍창기", titleStyle="8", text="홍창기 : ... 2루타"
 *       → counts.get("홍창기").h2b === 1.
 *   T3: title="5번타자 오재일", text="오재일 : 좌중간 솔로 홈런"
 *       → counts.get("오재일").hr === 1.
 *   T4: title="대주자 홍창기", text="홍창기 : 도루 성공" (h2b/h3b/hr 무관 결과)
 *       → counts.get("홍창기")가 undefined (도루는 hit 아님).
 *   T5: title="투수교체", textOptions에 " : " 분리자 없는 line → skip → no entry.
 *   T6: text="문정빈 : 우익수 앞 1루타" → 단타는 안 카운트 → no entry.
 *   T7: text="홍창기 : 1루수 옆 내야안타" → 내야안타도 단타 → no entry.
 *   T8: 같은 batter가 2번 안타 (서로 다른 row) → 누적 합산.
 *   T9: title 그대로 garbage key로 저장하지 않음 — counts.get("대타 문정빈")이
 *       undefined여야 record-API name lookup이 맞물림.
 */

import { tallyHitsFromRelays } from "@/lib/naver-relay-counts";

interface NaverTextOption {
  text: string;
  type: number;
}

interface NaverTextRelay {
  title: string;
  titleStyle: string;
  textOptions?: NaverTextOption[];
}

function mkRelay(
  title: string,
  titleStyle: string,
  opts: Array<{ text: string; type?: number }>,
): NaverTextRelay {
  return {
    title,
    titleStyle,
    textOptions: opts.map((o) => ({ text: o.text, type: o.type ?? 13 })),
  };
}

let assertions = 0;
let failures = 0;

function expect(label: string, actual: unknown, expected: unknown) {
  assertions += 1;
  const ok =
    JSON.stringify(actual) === JSON.stringify(expected) ||
    actual === expected;
  if (!ok) {
    failures += 1;
    console.error(
      `  ✗ ${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
    );
  } else {
    console.log(`  ✓ ${label}`);
  }
}

// =============================================================================

console.log("\n— T1: 대타 문정빈 3루타 — titleStyle=2 row enrichment (P0 회귀)");
{
  const relays = [
    mkRelay("대타 문정빈", "2", [
      { text: "문정빈 : 우익수 오른쪽 뒤 3루타", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("문정빈 entry exists", counts.has("문정빈"), true);
  expect("문정빈.h3b === 1", counts.get("문정빈")?.h3b, 1);
  expect("문정빈.h2b === 0", counts.get("문정빈")?.h2b, 0);
  expect("문정빈.hr === 0", counts.get("문정빈")?.hr, 0);
  // T9: garbage key 안 만들어짐
  expect("'대타 문정빈' garbage key 미존재", counts.has("대타 문정빈"), false);
}

console.log("\n— T2: 정상 라인업 2루타 — 기존 동작 보존");
{
  const relays = [
    mkRelay("3번타자 홍창기", "8", [
      { text: "홍창기 : 좌익수 위로 2루타", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("홍창기.h2b === 1", counts.get("홍창기")?.h2b, 1);
  expect("홍창기.h3b === 0", counts.get("홍창기")?.h3b, 0);
  expect("홍창기.hr === 0", counts.get("홍창기")?.hr, 0);
}

console.log("\n— T3: 홈런 분류");
{
  const relays = [
    mkRelay("5번타자 오재일", "8", [
      { text: "오재일 : 좌중간 솔로 홈런", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("오재일.hr === 1", counts.get("오재일")?.hr, 1);
  expect("오재일.h2b === 0", counts.get("오재일")?.h2b, 0);
}

console.log("\n— T4: 대주자 도루 — hit 아님, no entry");
{
  const relays = [
    mkRelay("대주자 홍창기", "2", [
      { text: "홍창기 : 2루로 도루 성공", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("도루는 no entry", counts.has("홍창기"), false);
}

console.log("\n— T5: 투수교체 등 ' : ' 분리자 없는 row → skip");
{
  const relays = [
    mkRelay("투수교체", "5", [
      { text: "LG 투수가 김OO로 교체됩니다", type: 13 },
    ]),
    mkRelay("공수교대", "0", [{ text: "1회말 LG 공격", type: 13 }]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("no entries from non-result rows", counts.size, 0);
}

console.log("\n— T6: 1루타는 카운트 안 함");
{
  const relays = [
    mkRelay("2번타자 문정빈", "8", [
      { text: "문정빈 : 우익수 앞 1루타", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("1루타 → no entry", counts.has("문정빈"), false);
}

console.log("\n— T7: 내야안타도 단타라 카운트 안 함");
{
  const relays = [
    mkRelay("1번타자 홍창기", "8", [
      { text: "홍창기 : 1루수 옆 내야안타", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("내야안타 → no entry", counts.has("홍창기"), false);
}

console.log("\n— T8: 같은 batter 두 번 안타 → 누적");
{
  const relays = [
    mkRelay("3번타자 홍창기", "8", [
      { text: "홍창기 : 좌익수 위로 2루타", type: 13 },
    ]),
    mkRelay("3번타자 홍창기", "8", [
      { text: "홍창기 : 우중간 솔로 홈런", type: 13 },
    ]),
  ];
  const counts = tallyHitsFromRelays(relays);
  expect("홍창기.h2b === 1", counts.get("홍창기")?.h2b, 1);
  expect("홍창기.hr === 1", counts.get("홍창기")?.hr, 1);
}

// =============================================================================

console.log(
  `\n${failures === 0 ? "✅ PASS" : "❌ FAIL"} — ${assertions} assertions, ${failures} failures`,
);
process.exit(failures === 0 ? 0 : 1);
