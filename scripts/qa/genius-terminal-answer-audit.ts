/**
 * 인입 질문 **전건 terminal 답변 감사** — 배포된 실제 배선을 그대로 태워, 유저가 받는
 * 답변 문자열과 근거를 판정한다.
 *
 * ⚠️ **왜 다시 썼나** (삼순 2026-08-08 P0).
 *
 * 1차 버전은 LLM·RAG 를 고정 stub 으로 채우고 `match_path` 만 셌다. 스크립트 주석에
 * 내가 직접 "모델 출력은 stub 이므로 무의미" 라고 적어놓고, 그 결과를 "전건 답변 검수
 * 완료" 로 보고했다. 그건 답변 검수가 아니라 **경로 시뮬레이션**이었다.
 * 하린아빠 지시는 "모든 인입된 질문들에 대해 답변 검수" 였다.
 *
 * 그래서 축을 바꿨다: `server.ts` 가 production 에 주입하는 **그 함수들을 직접 import** 해
 * 실호출한다(재구현 금지 — 검증기가 대상을 재구현하면 대상이 죽어도 GREEN 이다).
 *
 * ── 실호출 / 격리 경계 ──────────────────────────────────────────────────────
 *   실호출  loadGlossary · loadRosterPlayers · callLlm · searchRag/callRagLlm
 *           searchOfficialRag/callOfficialRagLlm · callTeamRagLlm
 *           searchNewsRag/callNewsRagLlm · fetchSeasonRecord/ServedRecord/TeamRecord
 *           getCache(읽기)  ← 유저가 실제로 받는 경로 그대로
 *   격리    reserveDaily  하루 5건 한도를 열어둔다. 안 그러면 6번째부터 전건이
 *                         `limited` 로 뭉개져 감사 자체가 무의미해진다.
 *           log           운영 로그 테이블 오염 금지(감사가 감사 대상을 늘리면 안 된다).
 *           setCache      **쓰기만** 차단하고 호출은 센다. 캐시 오염 없이 누수를 본다.
 *           releaseDaily  quota 를 안 깎으니 반납도 없다.
 *
 * ── 판정 규칙 ───────────────────────────────────────────────────────────────
 * 자동으로 **반증 가능한 것만** 판정한다. 의미 정합성("이 설명이 야구적으로 맞나")은
 * 사람 표본 검토 영역이고, 그것까지 PASS 로 뭉치면 또 "검수 완료" 라는 거짓 보고가 된다.
 *   FAIL  · 되묻기·차단 경로가 LLM 또는 cache write 를 소비했다(누수)
 *         · 생성 경로인데 답변이 비었다
 *         · 근거 없는 경로(`llm`)가 선수·구단 **수치**를 말했다  ← 환각 본체
 *         · 예외로 죽었다
 *   WARN  · 답변이 비정상적으로 짧다
 *         · RAG 경로인데 근거가 0개다
 *   PASS  그 외
 */
// ⚠️ **이 import 가 첫 줄이어야 한다.** 아래 `server.ts` 는 트랜지티브로
//   `supabase/admin` 싱글톤을 로드하고 그 싱글톤이 모듈 로드 시점에 env 를 요구한다.
//   같은 파일 안에서 env 를 읽는 방식은 ESM 평가 순서 때문에 이미 늦다(실측).
import "./_audit-env";

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";

import { createClient } from "@supabase/supabase-js";
import {
  answerQuestion,
  type QaDeps,
  type MatchPath,
  BLOCKED_ANSWER,
  UNCLEAR_ANSWER,
  UNSURE_ANSWER,
  STAT_CLARIFY_ANSWER,
  SERVICE_REDIRECT_ANSWER,
  HISTORY_HOLD_ANSWER,
  TEAM_STAT_HOLD_ANSWER,
  CONTEXT_MISSING_ANSWER,
  LLM_AMBIGUOUS_ANSWER,
  SCOPE_GUIDE_ANSWER,
  ACK_ANSWER,
  LIMITED_ANSWER,
  PLAYER_PICKER_ANSWER,
  SYSTEM_ERROR_ANSWER,
  mentionsTeamForGate,
} from "../../src/lib/baseball-qa/pipeline";
// ⚠️ production 이 주입하는 **그 함수들**이다. 여기서 재구현하지 않는다.
import {
  loadGlossary,
  callLlm,
  searchRag,
  callRagLlm,
  callTeamRagLlm,
  searchOfficialRag,
  callOfficialRagLlm,
  searchNewsRag,
  callNewsRagLlm,
  teamRagEnabled,
  newsRagEnabled,
} from "../../src/lib/baseball-qa/server";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import { createSeasonRecordFetcher, type SeasonRecordClient } from "../../src/lib/baseball-qa/stats/fetch-season-record";
import { createServedRecordFetcher } from "../../src/lib/baseball-qa/stats/served-record";
import { createTeamRecordFetchers } from "../../src/lib/baseball-qa/stats/team-record";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(SUPABASE_URL && SERVICE_ROLE, "service role 이 필요하다(운영 사전·로그·기록 조회)");
const admin = createClient(SUPABASE_URL!, SERVICE_ROLE!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/** 결정론 고정 문구 — 이게 나오면 "생성된 답변" 이 아니다. */
const CANNED_ANSWERS = new Set<string>([
  BLOCKED_ANSWER, UNCLEAR_ANSWER, UNSURE_ANSWER, STAT_CLARIFY_ANSWER,
  SERVICE_REDIRECT_ANSWER, HISTORY_HOLD_ANSWER, TEAM_STAT_HOLD_ANSWER,
  CONTEXT_MISSING_ANSWER, LLM_AMBIGUOUS_ANSWER, SCOPE_GUIDE_ANSWER,
  ACK_ANSWER, LIMITED_ANSWER, PLAYER_PICKER_ANSWER, SYSTEM_ERROR_ANSWER,
]);

type Outcome = "answered" | "clarify" | "unanswered";
const OUTCOME: Record<Exclude<MatchPath, "pending">, Outcome> = {
  dictionary: "answered", cache: "answered", llm: "answered", rag: "answered",
  team_rag: "answered", news_rag: "answered", kbo_structured: "answered", ack: "answered",
  scope_guide: "clarify", stat_clarify: "clarify", player_picker: "clarify",
  context_missing: "clarify",
  blocked: "unanswered", unsure: "unanswered", limited: "unanswered", error: "unanswered",
  service_redirect: "unanswered", history_hold: "unanswered",
};

/** 근거 기반으로 답한 경로 — 근거 0개면 WARN 대상. */
const RAG_PATHS = new Set<MatchPath>(["rag", "team_rag", "news_rag"]);
/** 근거 없이 모델이 생성한 경로 — 여기서 수치가 나오면 환각이다. */
const UNGROUNDED_PATHS = new Set<MatchPath>(["llm", "cache"]);

interface Counters {
  llm: number; cacheGet: number; cacheSet: number;
  playerRag: number; teamRag: number; newsRag: number; officialRag: number;
  evidenceCount: number;
}
const freshCounters = (): Counters => ({
  llm: 0, cacheGet: 0, cacheSet: 0,
  playerRag: 0, teamRag: 0, newsRag: 0, officialRag: 0, evidenceCount: 0,
});

/**
 * production 형상 deps. **배선 플래그도 production 함수로 읽는다** — 여기서 `true` 로
 * 하드코딩하면 운영이 꺼져 있는데 감사만 켜져 있는 상태를 못 본다.
 */
function prodDeps(counters: Counters): QaDeps {
  return {
    loadGlossary,
    loadPlayers: loadRosterPlayers,
    getCache: async (key) => { counters.cacheGet++; return null; },
    // ⚠️ 쓰기만 막고 **호출은 센다**. 캐시를 오염시키지 않으면서 누수를 관측한다.
    setCache: async () => { counters.cacheSet++; },
    callLlm: async (question, context) => {
      counters.llm++;
      return callLlm(question, context);
    },
    // 하루 한도 격리 — 이것만은 실호출하면 6번째 질문부터 전건이 `limited` 가 된다.
    reserveDaily: async (_userId, limit) => ({ allowed: true, remaining: limit - 1 }),
    log: async () => {},
    now: () => Date.now(),
    enablePlayerRag: true,
    enableTeamRag: teamRagEnabled(),
    enableNewsRag: newsRagEnabled(),
    searchRag: async (candidate, question) => {
      counters.playerRag++;
      const evidence = await searchRag(candidate, question);
      counters.evidenceCount += evidence.length;
      return evidence;
    },
    callRagLlm,
    callTeamRagLlm: async (question, evidence) => {
      counters.teamRag++;
      counters.evidenceCount += evidence.length;
      return callTeamRagLlm(question, evidence);
    },
    searchNewsRag: async (candidate, question) => {
      counters.newsRag++;
      const evidence = await searchNewsRag(candidate, question);
      counters.evidenceCount += evidence.length;
      return evidence;
    },
    callNewsRagLlm,
    searchOfficialRag: async (question) => {
      counters.officialRag++;
      const evidence = await searchOfficialRag(question);
      counters.evidenceCount += evidence.length;
      return evidence;
    },
    callOfficialRagLlm,
    fetchSeasonRecord: createSeasonRecordFetcher(admin as unknown as SeasonRecordClient),
    fetchServedRecord: createServedRecordFetcher(),
    fetchTeamRecord: createTeamRecordFetchers(),
  };
}

const PAGE = 1000;
/** 페이지 상한. 닿으면 통과가 아니라 **실패**다 — 잘린 표본으로 "결손 0" 은 최악이다. */
const MAX_PAGES = 50;

interface RawQuestion { question: string; count: number }

/**
 * 운영 로그 인입 질문을 **cutoff 로 고정**해 정규화 unique 로 뽑고, raw 빈도를 함께 센다.
 *
 * ⚠️ cutoff 가 없으면 감사 중에 새 질문이 들어와 표본이 흔들리고, 보고한 수치를 나중에
 *   재현할 수 없다(삼순 지적). cutoff 시각과 표본 hash 를 결과에 남긴다.
 */
async function loadQuestions(cutoffIso: string): Promise<{ unique: RawQuestion[]; rawTotal: number }> {
  const freq = new Map<string, RawQuestion>();
  let rawTotal = 0;
  let exhausted = false;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const from = page * PAGE;
    // query-guard: bounded-page -- MAX_PAGES 상한 + 상한 도달 시 아래에서 fail-close.
    const { data, error } = await admin
      .from("genius_question_logs")
      .select("question")
      .lte("created_at", cutoffIso)
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    assert.ok(!error, `로그 조회 실패: ${error?.message}`);
    const rows = (data ?? []) as Array<{ question: string | null }>;
    for (const row of rows) {
      const q = (row.question ?? "").trim();
      if (!q) continue;
      rawTotal += 1;
      const key = q.replace(/\s+/gu, " ").toLowerCase();
      const hit = freq.get(key);
      if (hit) hit.count += 1;
      else freq.set(key, { question: q, count: 1 });
    }
    if (rows.length < PAGE) { exhausted = true; break; }
  }
  assert.ok(exhausted, `로그가 페이지 상한(${MAX_PAGES}×${PAGE})을 넘었다. 상한을 올려 다시 돌려라`);
  return { unique: [...freq.values()], rawTotal };
}

/**
 * 답변에 수치가 있는가 (1차 필터).
 *
 * ⚠️ 이것만으로 환각이라고 판정하면 안 된다(2026-08-08 실측으로 교정). 룰 설명에는
 *   숫자가 당연히 나온다 — `스트라이크 3개`·`홈베이스를 밟으면 1점`·`3아웃`.
 *   초안은 그걸 전부 "근거 없는 수치 주장" 으로 신고했다. 정상 답변을 결함으로 부르는
 *   게이트는 신뢰를 잃고 결국 무시된다.
 */
const NUMERIC_CLAIM = /\d+\s*(?:개|점|승|패|홈런|안타|타점|도루|세이브|홀드|삼진|위)|0\.\d{3}|\d\.\d{2}\b/u;

/**
 * 그 수치가 **특정 대상에 귀속된 주장**인가 (2차 필터).
 *
 * 환각의 정의는 "숫자를 말했다" 가 아니라 **"확인할 수 없는 대상의 사실을 단정했다"** 다.
 * 그래서 답변에 로스터 선수명 또는 구단명이 함께 등장할 때만 위반으로 본다:
 *   · `스트라이크 3개를 당하면 아웃`            → 일반 룰. 위반 아님
 *   · `테임즈 선수가 유일하게 40-40 을 달성`     → 특정 선수 + 역사적 단정. 위반
 * 근거 없는 경로(`llm`·`cache`)는 그 주장을 검증할 수단이 없다.
 */
function attributesNumberToEntity(answer: string, playerNames: Set<string>): string | null {
  if (!NUMERIC_CLAIM.test(answer)) return null;
  for (const name of playerNames) {
    if (name.length >= 2 && answer.includes(name)) return name;
  }
  // 구단 판정은 **배포된 판정기**를 그대로 쓴다(`mentionsTeamForGate`). alias 표를 여기
  // 다시 적으면 구단 표기가 바뀔 때 게이트만 낡아 조용히 검출력을 잃는다.
  if (mentionsTeamForGate(answer)) return "team";
  return null;
}

type Verdict = "PASS" | "WARN" | "FAIL";
interface AuditRow {
  question: string;
  rawCount: number;
  source: MatchPath;
  outcome: Outcome;
  answer: string;
  answerLength: number;
  generated: boolean;
  evidenceCount: number;
  llmCalls: number;
  cacheWrites: number;
  /** 수치가 특정 대상(선수·구단)에 귀속됐다면 그 이름. 아니면 null. */
  entityNumericClaim: string | null;
  verdict: Verdict;
  reasons: string[];
}

function judge(row: Omit<AuditRow, "verdict" | "reasons">): { verdict: Verdict; reasons: string[] } {
  const fail: string[] = [];
  const warn: string[] = [];
  // ⚠️ **`blocked`·`unsure` 의 LLM 1회는 누수가 아니다**(2026-08-08 실측으로 판정 교정).
  //   `llm_scope_gate` 경로는 "이게 야구 질문인가" 를 LLM 에 묻고, `NOT_BASEBALL` 이면
  //   `blocked`·`UNSURE` 면 `unsure` 로 종결한다. 그 1회는 **범위 판정**이지 답변 생성이
  //   아니다. 이걸 FAIL 로 두면 게이트가 정상 설계를 결함으로 신고한다.
  //   대신 **cache write 는 0** 이어야 한다 — 답이 아닌 것을 캐시에 굳히면 안 된다.
  //
  //   반대로 아래 경로들은 LLM 앞단에서 결정론으로 끝나므로 **LLM 0** 이 계약이다.
  //   여기가 뚫리면 존재를 확인 못 한 대상의 기록을 모델이 지어낸다.
  const PRE_LLM_TERMINAL = new Set<MatchPath>([
    "stat_clarify", "history_hold", "scope_guide", "service_redirect",
    "ack", "dictionary", "player_picker", "limited", "context_missing",
  ]);
  if (PRE_LLM_TERMINAL.has(row.source) && row.llmCalls > 0) {
    fail.push(`결정론 경로가 LLM 을 호출했다(llm=${row.llmCalls})`);
  }
  if (row.outcome !== "answered" && row.cacheWrites > 0) {
    fail.push(`비답변을 캐시에 썼다(cacheW=${row.cacheWrites})`);
  }
  if ((row.source === "blocked" || row.source === "unsure") && row.llmCalls > 1) {
    fail.push(`범위판정 LLM 이 1회를 넘었다(llm=${row.llmCalls})`);
  }
  if (row.source === "error") fail.push("예외/시스템 오류");
  if (row.outcome === "answered" && row.answer.trim().length === 0) fail.push("답변이 비었다");
  if (UNGROUNDED_PATHS.has(row.source) && row.entityNumericClaim) {
    fail.push(`근거 없이 특정 대상의 수치를 단정(${row.entityNumericClaim})`);
  }
  // ⚠️ `kbo_structured` 는 **템플릿 + DB 원값**이라 짧은 게 정상이다(`한화 순위는 6위예요! ⚾`).
  //   초안은 이걸 "너무 짧다" 로 신고했다 — 정상 설계를 결함으로 부르는 게이트는 신뢰를
  //   잃고 결국 무시된다(2026-08-08 전건 실행에서 WARN 4건 전부 이 오탐이었다).
  //   길이 검사는 **모델이 서술한 경로**에만 적용한다.
  const NARRATIVE_PATHS = new Set<MatchPath>(["llm", "cache", "rag", "team_rag", "news_rag"]);
  if (NARRATIVE_PATHS.has(row.source) && row.generated && row.answerLength < 20) {
    warn.push(`서술형 답변이 너무 짧다(${row.answerLength}자)`);
  }
  if (RAG_PATHS.has(row.source) && row.evidenceCount === 0) warn.push("RAG 경로인데 근거 0개");
  if (fail.length > 0) return { verdict: "FAIL", reasons: fail };
  if (warn.length > 0) return { verdict: "WARN", reasons: warn };
  return { verdict: "PASS", reasons: [] };
}

async function runAudit(
  label: string,
  unique: RawQuestion[],
  playerNames: Set<string>,
): Promise<AuditRow[]> {
  const rows: AuditRow[] = [];
  let done = 0;
  for (const item of unique) {
    const counters = freshCounters();
    let source: MatchPath = "error";
    let answer = "";
    try {
      const result = await answerQuestion("audit-user", item.question, prodDeps(counters));
      source = result.source as MatchPath;
      answer = result.answer ?? "";
    } catch (err) {
      answer = `EXCEPTION: ${(err as Error).message}`;
    }
    const base = {
      question: item.question,
      rawCount: item.count,
      source,
      outcome: OUTCOME[source as Exclude<MatchPath, "pending">] ?? "unanswered",
      answer,
      answerLength: answer.length,
      generated: !CANNED_ANSWERS.has(answer),
      evidenceCount: counters.evidenceCount,
      llmCalls: counters.llm,
      cacheWrites: counters.cacheSet,
      entityNumericClaim: attributesNumberToEntity(answer, playerNames),
    };
    rows.push({ ...base, ...judge(base) });
    done += 1;
    if (done % 200 === 0) console.log(`  [${label}] ${done}/${unique.length}`);
  }
  return rows;
}

function summarize(label: string, rows: AuditRow[], rawTotal: number) {
  const byOutcome = new Map<Outcome, number>();
  const bySource = new Map<MatchPath, number>();
  const byVerdict = new Map<Verdict, number>();
  let weighted = 0;
  for (const r of rows) {
    byOutcome.set(r.outcome, (byOutcome.get(r.outcome) ?? 0) + 1);
    bySource.set(r.source, (bySource.get(r.source) ?? 0) + 1);
    byVerdict.set(r.verdict, (byVerdict.get(r.verdict) ?? 0) + 1);
    if (r.outcome === "answered") weighted += r.rawCount;
  }
  console.log(`\n── ${label} ── unique ${rows.length} · raw ${rawTotal}`);
  for (const o of ["answered", "clarify", "unanswered"] as Outcome[]) {
    const n = byOutcome.get(o) ?? 0;
    console.log(`  ${o.padEnd(12)} ${String(n).padStart(5)}  ${((n / rows.length) * 100).toFixed(1)}%`);
  }
  console.log(`  raw 가중 answered  ${weighted}/${rawTotal}  ${((weighted / rawTotal) * 100).toFixed(1)}%`);
  console.log(`  판정  PASS ${byVerdict.get("PASS") ?? 0} · WARN ${byVerdict.get("WARN") ?? 0} · FAIL ${byVerdict.get("FAIL") ?? 0}`);
  console.log("  match_path:");
  for (const [src, n] of [...bySource.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${src.padEnd(18)} ${String(n).padStart(5)}`);
  }
  return { byOutcome, bySource, byVerdict };
}

async function main() {
  const cutoffIso = new Date().toISOString();
  const { unique, rawTotal } = await loadQuestions(cutoffIso);
  const sampleHash = createHash("sha256")
    .update(unique.map((u) => u.question).join("\n"))
    .digest("hex")
    .slice(0, 16);
  console.log(`cutoff=${cutoffIso} · unique=${unique.length} · raw=${rawTotal} · sample=${sampleHash}`);
  assert.ok(unique.length >= 2000, `표본이 너무 적다(${unique.length}) — 조회가 끊겼을 수 있다`);

  // ⚠️ 표본 축소는 **디버깅 전용**이다. 축소 실행 결과를 "전건 감사" 로 보고하면
  //   그게 바로 이번 NO-GO 의 원인이었던 거짓 보고다. 축소면 아래 계약도 건너뛰고
  //   결과 파일에 축소 사실을 남긴다.
  const limitEnv = Number(process.env.AUDIT_SAMPLE_LIMIT ?? "0");
  const sampled = limitEnv > 0 ? unique.slice(0, limitEnv) : unique;
  if (limitEnv > 0) console.log(`⚠️ AUDIT_SAMPLE_LIMIT=${limitEnv} — 축소 실행(전건 아님)`);

  const started = Date.now();
  // 로스터 선수명 집합 — **배포 loader** 로 읽는다(재구현 금지).
  // 외국인 선수는 성만 쓰는 답변도 있으므로 마지막 토큰도 함께 담는다.
  const playerNames = new Set<string>();
  for (const player of await loadRosterPlayers()) {
    playerNames.add(player.name);
    const parts = player.name.split(/\s+/u);
    if (parts.length > 1) playerNames.add(parts[parts.length - 1]);
  }
  assert.ok(playerNames.size >= 500, `로스터가 비었다(${playerNames.size}) — 환각 판정이 무력해진다`);

  const rows = await runAudit("current", sampled, playerNames);
  const elapsedSec = Math.round((Date.now() - started) / 1000);
  console.log(`\n실행 ${elapsedSec}s · ${(sampled.length / Math.max(elapsedSec, 1)).toFixed(1)} q/s`);
  summarize("current (this branch)", rows, rawTotal);

  writeFileSync("/tmp/genius-terminal-audit.json", JSON.stringify({
    cutoffIso, sampleHash, uniqueTotal: unique.length, rawTotal,
    sampled: sampled.length, partial: limitEnv > 0, rows,
  }));

  // ── 계약 ──
  const fails = rows.filter((r) => r.verdict === "FAIL");
  if (fails.length > 0) {
    console.log("\n── FAIL 상세 ──");
    for (const r of fails.slice(0, 40)) {
      console.log(`  [${r.source}] ${r.reasons.join(" / ")}`);
      console.log(`     Q: ${r.question.slice(0, 70)}`);
      console.log(`     A: ${r.answer.slice(0, 90)}`);
    }
  }
  assert.equal(fails.length, 0, `FAIL ${fails.length}건 — 위 상세 참조`);
  assert.ok(limitEnv === 0, `AUDIT_SAMPLE_LIMIT 이 설정된 축소 실행은 전건 감사가 아니다(${limitEnv})`);

  console.log(`\n✅ genius terminal answer audit: unique ${unique.length}건(raw ${rawTotal}) 실배선 종단 실행 · FAIL 0`);
  console.log("   상세: /tmp/genius-terminal-audit.json");
  console.log("   ⚠️ 이 게이트는 누수·공백·수치환각을 판정한다. 의미 정합성은 사람 표본 검토 영역이다.");
}

main().catch((err) => {
  console.error("❌ terminal audit FAIL:", err);
  process.exit(1);
});
