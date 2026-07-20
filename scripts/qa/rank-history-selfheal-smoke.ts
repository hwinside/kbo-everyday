import { appendLiveRankIfStale } from "@/lib/analysis/rank-history-selfheal";

type Row = { date: string; rank: number };

const hist = (dates: [string, number][]): Row[] =>
  dates.map(([date, rank]) => ({ date, rank }));

let pass = 0;
let fail = 0;
function check(name: string, actual: Row[], expected: Row[]) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.log(`✗ ${name}\n    expected ${JSON.stringify(expected)}\n    got      ${JSON.stringify(actual)}`);
    fail++;
  }
}

const base = hist([
  ["2026-07-17", 2],
  ["2026-07-18", 2],
  ["2026-07-19", 2],
]);

// 1) 크론 스킵일: 최신 스냅샷(7/19) < 오늘(7/20) → 라이브 순위(3위) 오늘 포인트 append
check(
  "stale snapshot → append today live rank",
  appendLiveRankIfStale(base, "2026-07-20", 3),
  hist([["2026-07-17", 2], ["2026-07-18", 2], ["2026-07-19", 2], ["2026-07-20", 3]]),
);

// 2) 정상 크론일: 오늘(7/20) 스냅샷 이미 존재 → 무동작(중복 append 금지)
check(
  "today snapshot exists → no append",
  appendLiveRankIfStale(
    hist([["2026-07-19", 2], ["2026-07-20", 3]]),
    "2026-07-20",
    3,
  ),
  hist([["2026-07-19", 2], ["2026-07-20", 3]]),
);

// 3) 라이브 순위 없음 → 원본 그대로
check("null liveRank → unchanged", appendLiveRankIfStale(base, "2026-07-20", null), base);
check("undefined liveRank → unchanged", appendLiveRankIfStale(base, "2026-07-20", undefined), base);

// 4) 빈 히스토리 → anchor 불가, 원본(빈 배열) 그대로
check("empty history → unchanged", appendLiveRankIfStale([], "2026-07-20", 3), []);

// 5) 최신 스냅샷이 미래(방어): last.date > today → 손대지 않음
check(
  "future snapshot date → no append",
  appendLiveRankIfStale(hist([["2026-07-21", 2]]), "2026-07-20", 3),
  hist([["2026-07-21", 2]]),
);

// 6) 여러 날 스킵돼도 오늘 포인트 1개만 append(과거 갭은 조작하지 않음)
check(
  "multi-day gap → single today point only",
  appendLiveRankIfStale(hist([["2026-07-15", 2]]), "2026-07-20", 6),
  hist([["2026-07-15", 2], ["2026-07-20", 6]]),
);

// 7) 원본 배열 불변(부작용 없음)
const original = hist([["2026-07-19", 2]]);
appendLiveRankIfStale(original, "2026-07-20", 3);
check("does not mutate input", original, hist([["2026-07-19", 2]]));

// 8) rank 1 등 falsy-근접 값도 정상 append(0/1 경계)
check(
  "rank 1 appends correctly",
  appendLiveRankIfStale(hist([["2026-07-19", 2]]), "2026-07-20", 1),
  hist([["2026-07-19", 2], ["2026-07-20", 1]]),
);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
