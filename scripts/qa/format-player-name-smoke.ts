import { formatPlayerDisplayName } from "@/lib/utils/player-name";

const cases: Array<[string | null | undefined, string]> = [
  // 외국인 (서양 — 성이 뒤)
  ["요니 치리노스", "치리노스"],
  ["라울 알칸타라", "알칸타라"],
  ["기예르모 에레디아", "에레디아"],
  ["맷 매닝", "매닝"],
  // 일본 (관행상 given name 사용 — 마지막 토큰)
  ["가나쿠보 유토", "유토"],
  ["도다 나츠키", "나츠키"],
  // 한국 (공백 없음)
  ["강백호", "강백호"],
  ["김도영", "김도영"],
  // 엣지
  [null, ""],
  [undefined, ""],
  ["", ""],
  ["   ", ""],
  [" 요니 치리노스 ", "치리노스"], // trim
  ["요니  치리노스", "치리노스"],   // 이중 공백
];

let pass = 0;
let fail = 0;
for (const [input, expected] of cases) {
  const actual = formatPlayerDisplayName(input);
  if (actual === expected) {
    console.log(`✓ ${JSON.stringify(input)} → ${JSON.stringify(actual)}`);
    pass++;
  } else {
    console.log(`✗ ${JSON.stringify(input)} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    fail++;
  }
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
