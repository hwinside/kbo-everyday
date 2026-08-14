/**
 * 팀별 팬 카피 30종 SSOT 게이트 (rev2, 2026-08-14).
 *
 * 검증 축 — 전부 **실제 배포 모듈**을 tsx 로 로드해 검사한다 (fixture 조작 금지, M90):
 *   [1] 구조: 활성 30종 = 10팀 × 3종 exact, 예비 1종(NC-4), 팀 키 = TEAMS.id 폐쇄집합.
 *   [2] 결속: 모든 행(예비 포함)의 sourceId ∈ 레지스트리 17건 폐쇄집합. 행별 결속(섹션 결속 0).
 *   [3] 톤: 전 카피 합니다체 종결(`~다.`), 해요체 종결 0, 절대표현 0.
 *   [4] 렌더: 첫 문장 `{팀명}를 응원하신다니 반갑습니다.` 정확히 1회 + 카피 본문.
 *   [5] 결정론: 같은 (teamId, seed) → 같은 출력. seed 3연속이 3종을 모두 순회.
 *   [6] fail-open: 미설정(null)·미지원(0)·비정상 teamId → null.
 *   [7] 파이프라인 배선: pipeline.ts 가 pickTeamFanCopy 를 greeting 에서만 소비하는 소스 결속.
 *
 * 검증력 증명(결함주입): 판정 함수를 변조 사본에도 태워 RED 가 나는지 self-test 한다 —
 * "통과"가 검증력 없는 GREEN 이 아님을 게이트 스스로 증명한다 (M90 검증기 계약).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TEAM_FAN_COPY,
  TEAM_FAN_COPY_SPARE,
  TEAM_FAN_COPY_SOURCE_IDS,
  TEAM_FAN_COPY_DOC_SHA256,
  teamFanGreeting,
  renderTeamFanCopy,
  type TeamFanCopyRow,
} from "../../src/lib/constants/baseball-genius-team-copy";
import { TEAMS } from "../../src/lib/constants/teams";

let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── 판정 함수 (self-test 가 변조 사본에도 태운다) ─────────────────────────────
const FORBIDDEN_ABSOLUTES = ["최고", "최강", "유일", "무조건", "절대", "레전드", "우승할"];
function validateCopySet(copySet: Readonly<Record<number, readonly TeamFanCopyRow[]>>): string[] {
  const errors: string[] = [];
  const teamIds = Object.keys(copySet).map(Number).sort((a, b) => a - b);
  const expected = TEAMS.map((t) => t.id).sort((a, b) => a - b);
  if (JSON.stringify(teamIds) !== JSON.stringify(expected)) {
    errors.push(`팀 키 불일치: ${JSON.stringify(teamIds)}`);
  }
  const sourceIds = new Set<string>(TEAM_FAN_COPY_SOURCE_IDS);
  const seenRowIds = new Set<string>();
  let total = 0;
  for (const teamId of teamIds) {
    const rows = copySet[teamId] ?? [];
    if (rows.length !== 3) errors.push(`team ${teamId}: 행 ${rows.length}개 (3 필요)`);
    for (const row of rows) {
      total++;
      if (seenRowIds.has(row.id)) errors.push(`중복 행 id: ${row.id}`);
      seenRowIds.add(row.id);
      if (!sourceIds.has(row.sourceId)) errors.push(`${row.id}: 미등록 sourceId ${row.sourceId}`);
      // 합니다체 = `~니다.` 종결 전반 (됩니다·줍니다·나타냅니다 포함). #1186 톤 SSOT와 같은 축.
      if (!/니다[.!]?$/.test(row.text.trim())) {
        errors.push(`${row.id}: 합니다체 종결 아님 — "${row.text.slice(-12)}"`);
      }
      if (/(요[.!?]?\s*$)/.test(row.text.trim())) errors.push(`${row.id}: 해요체 종결`);
      for (const word of FORBIDDEN_ABSOLUTES) {
        if (row.text.includes(word)) errors.push(`${row.id}: 절대표현 "${word}"`);
      }
    }
  }
  if (total !== 30) errors.push(`활성 총계 ${total} (30 필요)`);
  return errors;
}

// [1][2][3] 실 SSOT 판정
const realErrors = validateCopySet(TEAM_FAN_COPY);
check("SSOT 구조·결속·톤 (30종 = 10팀×3)", realErrors.length === 0, realErrors.join(" | "));
check("예비 NC-4 결속·톤", TEAM_FAN_COPY_SPARE.id === "NC-4"
  && (TEAM_FAN_COPY_SOURCE_IDS as readonly string[]).includes(TEAM_FAN_COPY_SPARE.sourceId)
  && /습니다\.$/.test(TEAM_FAN_COPY_SPARE.text));
// 삼순 최종 GO 문서 exact — **equality** 로 검사한다 (형식 검사는 false-green, 삼순 1차 지적).
//   이 리터럴이 게이트의 정본이다 — 문서 재검수(새 GO exact) 없이 SSOT 해시만 바꾸면 RED.
const APPROVED_DOC_SHA256 = "05c166231ce97cae0cc9f373ad504dcda65157c997bc41f70e7ae31338153f23";
check("문서 exact 결속 (승인 sha256 equality)", TEAM_FAN_COPY_DOC_SHA256 === APPROVED_DOC_SHA256,
  `SSOT=${TEAM_FAN_COPY_DOC_SHA256}`);

// [4] 렌더 규칙 — 전 팀에서 첫 문장 정확히 1회
{
  let ok = true;
  const details: string[] = [];
  for (const team of TEAMS) {
    const rendered = renderTeamFanCopy(team.id, 0);
    const greeting = teamFanGreeting(team.name);
    if (!rendered || !rendered.startsWith(`${greeting} `)) {
      ok = false; details.push(`team ${team.id}: 첫 문장 누락`);
      continue;
    }
    const count = rendered.split("응원하신다니 반갑습니다").length - 1;
    if (count !== 1) { ok = false; details.push(`team ${team.id}: 첫 문장 ${count}회`); }
    const body = rendered.slice(greeting.length + 1);
    if (!TEAM_FAN_COPY[team.id]?.some((r) => r.text === body)) {
      ok = false; details.push(`team ${team.id}: 본문이 승인 카피가 아님`);
    }
  }
  check("렌더 규칙 (첫 문장 1회 + 승인 카피 본문)", ok, details.join(" | "));
}

// [5] 결정론 + 3종 순회
{
  const a = renderTeamFanCopy(1, 12345);
  const b = renderTeamFanCopy(1, 12345);
  const cycle = new Set([renderTeamFanCopy(1, 0), renderTeamFanCopy(1, 1), renderTeamFanCopy(1, 2)]);
  check("로테이션 결정론 (같은 seed → 같은 출력)", a !== null && a === b);
  check("로테이션 순회 (seed 0·1·2 → 3종 전부)", cycle.size === 3);
  check("음수 seed 안전", renderTeamFanCopy(1, -7) !== null);
}

// [6] fail-open
check("fail-open (null·0·미지원 팀 → null)",
  renderTeamFanCopy(null, 1) === null
  && renderTeamFanCopy(0, 1) === null
  && renderTeamFanCopy(99, 1) === null
  && renderTeamFanCopy(Number.NaN, 1) === null);

// [7] 파이프라인·서버 배선 — **실제 모듈을 로드**해 결속한다 (삼순 1차 P0:
//   정규식만 읽는 검사는 import 누락 TS2304 를 놓친다 — tsc 범위 밖 파일은 tsx 실로드가
//   유일한 컴파일 증명이다, 8/14 M90 계약). supabase 클라이언트는 모듈 init 싱글턴이므로
//   dummy env 로 로드만 한다 — 네트워크 호출 0.
async function checkServerBinding(): Promise<void> {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= "https://smoke-dummy.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= "smoke-dummy-anon-key";
  let server: typeof import("../../src/lib/baseball-qa/server");
  try {
    server = await import("../../src/lib/baseball-qa/server");
  } catch (e) {
    check("server 모듈 실로드 (컴파일·import 결속)", false, (e as Error).message.slice(0, 200));
    return;
  }
  check("server 모듈 실로드 (컴파일·import 결속)", true);
  const withUser = server.makeDeps(1, null, null, false, "00000000-0000-0000-0000-000000000001");
  const withoutUser = server.makeDeps(1, null, null, false);
  check("makeDeps 실결속 (signatureUserId → pickTeamFanCopy 함수)",
    typeof withUser.pickTeamFanCopy === "function");
  check("makeDeps 실결속 (유저 없으면 미주입 → 기존 경로)",
    withoutUser.pickTeamFanCopy === undefined);
  const pipelineSrc = readFileSync(join(process.cwd(), "src/lib/baseball-qa/pipeline.ts"), "utf8");
  check("pipeline 배선 (greeting 한정 가드)",
    /route === "ack" && isGreetingPhrase\(question\) && deps\.pickTeamFanCopy/.test(pipelineSrc));
}

// ── 결함주입 self-test — 판정 함수가 실제로 RED 를 내는지 증명 ────────────────
function mutated(mutator: (rows: TeamFanCopyRow[][]) => void): Record<number, readonly TeamFanCopyRow[]> {
  const clone = Object.fromEntries(
    Object.entries(TEAM_FAN_COPY).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
  ) as Record<number, TeamFanCopyRow[]>;
  mutator(Object.values(clone));
  return clone;
}
const injections: Array<[string, Record<number, readonly TeamFanCopyRow[]>]> = [
  ["행 삭제 (29종)", mutated((teams) => { teams[0].pop(); })],
  ["미등록 sourceId", mutated((teams) => { teams[0][0].sourceId = "FAKE_SOURCE"; })],
  ["해요체 종결", mutated((teams) => { teams[0][0].text = "LG는 좋은 팀이에요"; })],
  ["절대표현 주입", mutated((teams) => { teams[0][0].text = "LG는 리그 최강 구단입니다."; })],
  ["행 id 중복", mutated((teams) => { teams[1][0].id = teams[0][0].id; })],
];
for (const [name, bad] of injections) {
  const errors = validateCopySet(bad);
  check(`결함주입 RED: ${name}`, errors.length > 0);
}

// tsx cjs 변환은 top-level await 미지원 — promise 체인으로 종결한다.
void checkServerBinding().then(() => {
  if (failures > 0) {
    console.error(`\nFAIL baseball-genius-team-copy: ${failures}건`);
    process.exit(1);
  }
  console.log("\nPASS baseball-genius-team-copy: 전 축 GREEN (결함주입 RED 5/5 + server 실로드 포함)");
}).catch((e) => {
  console.error("FAIL baseball-genius-team-copy: 게이트 자체 예외", e);
  process.exit(1);
});
