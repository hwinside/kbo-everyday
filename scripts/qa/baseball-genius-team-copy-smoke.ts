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
import { createHash } from "node:crypto";
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

// canonical payload digest (삼순 2차 P0) — 문자열 리터럴끼리의 비교는 카피·sourceId 가
//   바뀌어도 통과한다. **실제 30+1 payload**(팀별 id·text·sourceId + 예비 + 문서 exact)를
//   결정론 직렬화해 sha256 으로 잠근다. 카피 한 글자·결속 한 칸이라도 바뀌면 RED —
//   수정은 문서 재검수(삼순 GO) → 이 digest 갱신 순서로만 가능하다.
function canonicalPayloadDigest(): string {
  const canonical = JSON.stringify({
    doc: TEAM_FAN_COPY_DOC_SHA256,
    sources: [...TEAM_FAN_COPY_SOURCE_IDS],
    teams: Object.keys(TEAM_FAN_COPY).map(Number).sort((a, b) => a - b).map((teamId) => [
      teamId,
      (TEAM_FAN_COPY[teamId] ?? []).map((r) => [r.id, r.text, r.sourceId]),
    ]),
    spare: [TEAM_FAN_COPY_SPARE.id, TEAM_FAN_COPY_SPARE.text, TEAM_FAN_COPY_SPARE.sourceId],
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
const APPROVED_PAYLOAD_SHA256 = "82b625137a9b349cd30671e33e54473e031bb59271d61ff0413f9d8f59dc7cd5";
check("payload canonical digest 결속 (30+1 실내용 sha256 equality)",
  canonicalPayloadDigest() === APPROVED_PAYLOAD_SHA256,
  `payload=${canonicalPayloadDigest()}`);

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

  // 배선은 정규식이 아니라 **answerQuestion 실실행**으로 검증한다 (삼순 2차 교훈:
  //   `false &&` 로 죽여도 소스 문자열은 남아 regex 는 GREEN — mutation 이 실증했다).
  const pipeline = await import("../../src/lib/baseball-qa/pipeline");
  const { answerQuestion, GREETING_ANSWER, ACK_ANSWER, isGreetingPhrase, isAckPhrase } = pipeline;
  const GREETING_Q = "반가워";
  const ACK_Q = "고마워";
  check("입력 전제 (greeting/ack 판정기 실확인)", isGreetingPhrase(GREETING_Q) && isAckPhrase(ACK_Q));
  const TEAM_COPY_FIXED = renderTeamFanCopy(1, 7);
  function stubDeps(pick: (() => Promise<string | null>) | undefined, calls: string[]) {
    return {
      loadGlossary: async () => [],
      loadPlayers: async () => [],
      getCache: async () => null,
      setCache: async () => { calls.push("setCache"); },
      callLlm: async () => { throw new Error("llm must not be called"); },
      reserveDaily: async () => ({ allowed: true, remaining: 19 }),
      log: async () => {},
      ...(pick ? { pickTeamFanCopy: pick } : {}),
    };
  }
  {
    const calls: string[] = [];
    const res = await answerQuestion("u1", GREETING_Q, stubDeps(async () => { calls.push("pick"); return TEAM_COPY_FIXED; }, calls) as never);
    check("pipeline 실실행 (greeting + 팀 → 팀 카피 답변)",
      res.source === "ack" && res.answer === TEAM_COPY_FIXED && calls.includes("pick"),
      `source=${res.source} answer=${String(res.answer).slice(0, 40)}`);
  }
  {
    const calls: string[] = [];
    const res = await answerQuestion("u1", GREETING_Q, stubDeps(async () => null, calls) as never);
    check("pipeline 실실행 (greeting + 팀 없음 → 기존 인사 fail-open)", res.answer === GREETING_ANSWER);
  }
  {
    const calls: string[] = [];
    const res = await answerQuestion("u1", ACK_Q, stubDeps(async () => { calls.push("pick"); return TEAM_COPY_FIXED; }, calls) as never);
    check("pipeline 실실행 (ack 감사 인사 → 카피 미부착·미호출)",
      res.answer === ACK_ANSWER && !calls.includes("pick"));
  }
  {
    const calls: string[] = [];
    const res = await answerQuestion("u1", GREETING_Q, stubDeps(async () => { throw new Error("boom"); }, calls) as never);
    check("pipeline 실실행 (카피 조회 throw → 인사 생존 fail-open)", res.answer === GREETING_ANSWER);
  }
}

// ── 결함주입 self-test — 판정 함수가 실제로 RED 를 내는지 증명 ────────────────
type MutableRow = { -readonly [K in keyof TeamFanCopyRow]: TeamFanCopyRow[K] };
function mutated(mutator: (rows: MutableRow[][]) => void): Record<number, readonly TeamFanCopyRow[]> {
  const clone = Object.fromEntries(
    Object.entries(TEAM_FAN_COPY).map(([k, rows]) => [k, rows.map((r) => ({ ...r }))]),
  ) as Record<number, MutableRow[]>;
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
