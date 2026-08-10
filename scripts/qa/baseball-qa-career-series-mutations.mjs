/**
 * career-series 게이트 검출력 증명 — 소스 결함주입 후 smoke 가 RED 가 되는지 확인한다.
 *
 * 계약 (2026-08-09 #1137 교훈 반영):
 *  - 원복은 in-memory 백업 → finally 에서 무조건 복원. `process.exit()` 금지
 *    (finally 원복을 건너뛴다 — 2026-08-10 실측).
 *  - RED 판정은 exit code 가 아니라 **FAIL 마커**로 한다 — 컴파일 오류 등 아무
 *    nonzero 를 "검출 성공"으로 세면 검출력이 없는 게이트도 통과한다.
 *  - 앵커 문자열이 소스에 없으면 러너 고장이다 — SKIP 이 아니라 FAIL 로 끝낸다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const CAREER = "src/lib/baseball-qa/stats/career-series.ts";
const SEASON_RECORD = "src/lib/baseball-qa/stats/season-record.ts";
const PIPELINE = "src/lib/baseball-qa/pipeline.ts";

const SEASON = "src/lib/baseball-qa/stats/season-record.ts";

const MUTATIONS = [
  {
    name: "m8 최근N 범위 fail-close 제거 — 최근 3년/10경기가 전 커리어로 축소",
    file: SEASON,
    from: 'if (scan.recentRange) return { kind: "unsupported_season" };',
    to: "",
  },
  {
    name: "m9 극값(최고/커리어하이) fail-close 제거 — 통산 평균으로 축소",
    file: SEASON,
    from: "if (/최고|최저|최악|커리어\\s*하이|하이라이트|베스트|기록\\s*경신/.test(scan.spaced)) {",
    to: "if (false) {",
  },
  {
    name: "m10 복수 시점 참조 판정 제거 — 작년과 올해 비교가 단일값으로 둔갑",
    file: SEASON,
    from: 'if (scan.refTotal > 1) return { kind: "unsupported_season" };',
    to: "",
  },
  {
    name: "m11 범위 표지(까지·이후·부터) 결속 제거 — 작년까지가 작년 단일값으로 축소",
    file: SEASON,
    from: "if (scan.rangeMarker && (scan.refTotal > 0 || scan.careerWord)) {",
    to: "if (false) {",
  },
  {
    name: "m12 데뷔 bounded 범위 검출 제거 — 데뷔 후 3년이 전 커리어로 축소 (삼순 4차 재현)",
    file: SEASON,
    from: 'if (/(?:데뷔|입단)[^]{0,8}?\\d+(?:년|시즌)/.test(rest)) {',
    to: "if (false) {",
    smoke: "scripts/qa/baseball-qa-career-series-smoke.ts",
  },
  {
    name: "m16 서수 동치(번째) 흡수 제거 — 데뷔 후 첫 번째 시즌이 career total 로 축소 (삼순 7차 재현)",
    file: SEASON,
    from: "/(?:데뷔|입단)[^]{0,10}?첫(?:번째)?(?:해|시즌|경기|타석|등판|년도?)/",
    to: "/(?:데뷔|입단)[^]{0,8}?첫(?:해|시즌|경기|타석|등판)/",
    smoke: "scripts/qa/baseball-qa-career-series-smoke.ts",
  },
  {
    name: "m15 single 마커 선차단 제거 — 입단 후 첫해가 career total 로 축소 (삼순 6차 재현)",
    file: SEASON,
    from: '} else if (/(?:데뷔|입단)[^]{0,10}?첫(?:번째)?(?:해|시즌|경기|타석|등판|년도?)/.test(rest)) {',
    to: "} else if (false) {",
    smoke: "scripts/qa/baseball-qa-career-series-smoke.ts",
  },
  {
    name: "m13 debutScope other fail-close 제거 — 데뷔 시즌/bare 데뷔가 축소 (삼순 5차 재현)",
    file: SEASON,
    from: 'if (scan.debutScope === "other") return { kind: "unsupported_season" };',
    to: "",
    smoke: "scripts/qa/baseball-qa-career-series-smoke.ts",
  },
  {
    name: "m14 full_origin career 동치 제거 — 데뷔 이래 홈런이 현재시즌으로 축소 (삼순 5차 재현)",
    file: SEASON,
    from: 'if (scan.careerWord || scan.debutScope === "full_origin") {',
    to: "if (scan.careerWord) {",
    smoke: "scripts/qa/baseball-qa-career-series-smoke.ts",
  },
  {
    name: "m1 identity 대조 제거 — 다른 선수 기록이 그대로 나간다",
    file: PIPELINE,
    from: "if (!record || record.playerName !== candidate.name) {",
    to: "if (!record) {",
  },
  {
    name: "m2 연도 오름차순 검증 제거",
    file: CAREER,
    from: "if (rows[i].year <= rows[i - 1].year) return null;",
    to: "if (false) return null;",
  },
  {
    name: "m3 연도 범위(1982~현재) 검증 제거",
    file: CAREER,
    from: "if (!Number.isInteger(year) || year < KBO_FIRST_SEASON || year > currentSeason) return null;",
    to: "if (!Number.isInteger(year)) return null;",
  },
  {
    name: "m4 값 형식 검증 무력화",
    file: CAREER,
    from: "return /^\\d+$/.test(value) || /^\\d+\\.\\d{1,3}$/.test(value) || /^\\d+(?: \\d\\/\\d)?$/.test(value) || value === \"-\";",
    to: "return true;",
  },
  {
    name: "m5 시리즈 의도어 제거 — 캡처 질문이 올해 단일값으로 회귀",
    file: SEASON_RECORD,
    from: 'const SERIES_WORDS = ["연도별", "년도별", "시즌별", "해마다", "매년", "추이"];',
    to: 'const SERIES_WORDS = [];',
  },
  {
    name: "m6 시리즈 렌더의 컬럼 결측 fail-close 제거",
    file: CAREER,
    from: "if (value === undefined) return null; // 컬럼 결측 = 테이블 구조 변화 — 답하지 않는다.",
    to: "if (value === undefined) continue;",
  },
  {
    name: "m7 신원 마커(lblName) 요구 제거",
    file: CAREER,
    from: "if (!playerName) return null;",
    to: "if (false) return null;",
  },
];

const backups = new Map();
let failures = 0;
try {
  for (const mutation of MUTATIONS) {
    const original = readFileSync(mutation.file, "utf-8");
    if (!original.includes(mutation.from)) {
      console.log(`FAIL(runner) ${mutation.name} :: 앵커 부재 — 러너가 소스와 어긋났다`);
      failures += 1;
      continue;
    }
    backups.set(mutation.file, original);
    writeFileSync(mutation.file, original.replace(mutation.from, mutation.to));
    let out = "";
    try {
      out = execFileSync("npx", ["tsx", "scripts/qa/baseball-qa-career-series-smoke.ts"], {
        encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000,
      });
    } catch (error) {
      out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    } finally {
      writeFileSync(mutation.file, original);
      backups.delete(mutation.file);
    }
    // RED = smoke 의 FAIL 마커가 찍혔다 (컴파일 오류·러너 고장은 RED 로 안 센다).
    const red = /\nFAIL /.test(`\n${out}`) && out.includes("baseball QA career series:");
    console.log(`${red ? "RED " : "MISS"} ${mutation.name}`);
    if (!red) failures += 1;
  }
} finally {
  for (const [file, original] of backups) writeFileSync(file, original);
}
console.log(failures === 0 ? `\n✅ mutations: ${MUTATIONS.length}/${MUTATIONS.length} RED` : `\n❌ ${failures} 축 미검출`);
process.exitCode = failures === 0 ? 0 : 1;
