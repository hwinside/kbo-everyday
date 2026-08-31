/** team 귀속 held-out (삼순 2026-08-31): 10구단 양성 · 무구단 null · 타구단 오결속 0. */
import { classifyIntent } from "../../src/lib/baseball-qa/server";
import { parseIntentResponse, KBO_TEAM_CANONICALS } from "../../src/lib/baseball-qa/intent";

// 게이트 코호트에 없는 표현으로만 구성한다(held-out). 구단명을 문장에 쓰지 않은 것도 섞는다.
const POS: Array<[string, string]> = [
  ["잠실 구장 응원가 중에 제일 유명한 거 뭐야?", "LG"],
  ["기아 챔피언스필드 이름 유래가 뭐야?", "KIA"],
  ["곰돌이 마스코트 이름이 뭐였지?", "두산"],
  ["사직구장 응원 문화가 왜 유명해?", "롯데"],
  ["라이온즈파크 좌석은 어떻게 나뉘어?", "삼성"],
  ["대전 신구장 이름이 뭐야?", "한화"],
  ["고척돔은 왜 실내야?", "키움"],
  ["수원 위즈파크 굿즈샵 어디 있어?", "KT"],
  ["랜더스필드 바비큐존이 뭐야?", "SSG"],
  ["창원 신축구장 특징이 뭐야?", "NC"],
];
const NEG: string[] = [
  "인필드 플라이 규칙이 뭐야?", "낫아웃은 언제 성립해?", "타율은 어떻게 계산해?",
  "야구 경기는 몇 이닝이야?", "지명타자 제도가 뭐야?",
];
(async () => {
  let posOk = 0, misbind = 0, negOk = 0;
  const rows: unknown[] = [];
  console.log("=== 양성(구단 귀속 기대) ===");
  for (const [q, want] of POS) {
    const d = parseIntentResponse((await classifyIntent(q)).text, { question: q });
    const got = d.team ?? "-";
    const ok = got === want;
    const wrong = got !== "-" && got !== want;   // 타구단 오결속
    if (ok) posOk++; if (wrong) misbind++;
    rows.push({ q, want, got, ok, wrong });
    console.log(`  ${ok ? "OK " : wrong ? "MISBIND" : "MISS"} ${q.slice(0, 24).padEnd(26)} want=${want} got=${got}`);
  }
  console.log("=== 음성(무구단 규칙질문 → null 기대) ===");
  for (const q of NEG) {
    const d = parseIntentResponse((await classifyIntent(q)).text, { question: q });
    const got = d.team ?? "-";
    const ok = got === "-";
    if (ok) negOk++; else misbind++;
    rows.push({ q, want: "-", got, ok, wrong: !ok });
    console.log(`  ${ok ? "OK " : "MISBIND"} ${q.slice(0, 24).padEnd(26)} got=${got}`);
  }
  console.log(`\n양성 ${posOk}/${POS.length} · 음성 ${negOk}/${NEG.length} · 타구단 오결속 ${misbind}`);
  console.log(`폐쇄집합 ${KBO_TEAM_CANONICALS.length}개`);
  require("node:fs").writeFileSync(
    "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/team-heldout-20260901.json",
    JSON.stringify({ at: new Date().toISOString(), posOk, posTotal: POS.length, negOk, negTotal: NEG.length, misbind, rows }, null, 2));
})();
