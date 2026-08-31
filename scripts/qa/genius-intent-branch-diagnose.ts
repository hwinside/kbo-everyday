/**
 * 분기점 좁히기 진단 — 삼순 2026-08-31 지시.
 *
 * ## 왜 이 스크립트가 따로 필요한가
 *
 * 앞선 보고에서 나는 `한화 몬스터월은 뭐야?` 의 official 누수를 `normalizeQuestionLlm`
 * 비결정성 탓으로 지목했는데, 삼순이 코드를 직접 읽고 **그 추정이 성립하지 않음**을
 * 지적했다:
 *   · `null` → `no_change`, `candidate === question` → `rejected`.
 *     **둘 다 `accepted=false` 라 실제 question 은 그대로다.**
 *   그러므로 5:1 상관은 team→official 분기를 설명할 수 없다.
 *
 * 게다가 내가 만든 "입력 동등성 증거" 자체가 결함이었다 — 전역 배열에 push 하고
 * `slice(mark)` 로 잘랐는데 **동시 실행(conc=4)이라 다른 run 의 요청이 섞였다**
 * (몬스터월 3행의 bodyHashes 가 29/30/31개). 증거를 만들겠다고 만든 것이 증거가 아니었다.
 *
 * ## 그래서 이 스크립트가 하는 일
 *
 *   ① **순차 실행**(동시성 1). 캡처 오염을 원천 차단한다.
 *   ② seam 별 **1:1 해시** — intent / normalize / 그 외 LLM 을 각각 따로 센다.
 *   ③ 파이프라인 판정 필드를 **순서대로** 스냅샷:
 *        normalize raw · codepoint · NFKC hash · candidate verdict
 *        → route → mentionedTeams → teamCandidate → teamServable
 *   ④ 회차 간 **최초로 갈리는 필드**를 지목한다.
 *
 * 🔴 이 스크립트는 **아무것도 고치지 않는다.** 분기점을 확정하기 전에 수정하면
 *   없는 결함을 고치게 된다(2026-08-19 M90).
 *
 * 실행:
 *   npx tsx --require ./scripts/qa/_a0-preload.cjs scripts/qa/genius-intent-branch-diagnose.ts --reps 8
 */
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  answerQuestion, routeQuestion, isSupportedRuleTermQuestion,
  resolveRagTeamCandidate, isTeamRagServableQuestion,
  mentionsAnyRosterName, mentionedTeamCanonicals,
  type QaDeps, type LlmResult,
} from "../../src/lib/baseball-qa/pipeline";
import {
  loadGlossary, callLlm, mapGlossaryDefinition, normalizeQuestionLlm,
  searchRag, callRagLlm, callTeamRagLlm, teamRagEnabled,
  searchOfficialRag, callOfficialRagLlm, classifyIntent,
} from "../../src/lib/baseball-qa/server";
import { loadRosterPlayers } from "../../src/lib/baseball-qa/roster/load-roster-players";
import { parseIntentResponse } from "../../src/lib/baseball-qa/intent";

const OUT = "/Users/harinclaw/.openclaw/workspace/state/yaj-48h/intent-branch-diagnose-20260831.json";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const REPS = Number(arg("reps", "8"));

/** 흔들린다고 관측된 3행 + 대조군. */
const TARGETS = [
  "한화 몬스터월은 뭐야?",
  "호걸이 이름 뜻이뭐야?",
  "OVR",
  "보크가 뭐야?", // 대조군 — 안정적으로 official 로 가야 정상
];

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}
/** 눈에 안 보이는 유니코드 차이를 드러낸다 — NFKC 전/후를 따로 남긴다. */
function codepoints(text: string): string {
  return [...text].map((ch) => ch.codePointAt(0)!.toString(16)).join(",");
}

/** seam 별 캡처 — run 마다 새로 만든다(전역 누적 금지, 이게 앞선 결함이었다). */
interface SeamCapture {
  intent: string[];
  normalize: string[];
  other: string[];
}

async function main() {
  console.log(`[branch-diagnose] ${TARGETS.length}건 × ${REPS}rep · 순차 실행(conc=1)\n`);
  const glossary = await loadGlossary();
  const players = await loadRosterPlayers();

  const rows: Array<Record<string, unknown>> = [];

  for (const question of TARGETS) {
    const snapshots: Array<Record<string, unknown>> = [];

    for (let i = 0; i < REPS; i += 1) {
      const seam: SeamCapture = { intent: [], normalize: [], other: [] };
      // 어느 seam 이 지금 호출 중인지 표시해 fetch 래퍼가 1:1로 귀속시킨다.
      let current: keyof SeamCapture = "other";
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === "string") seam[current].push(sha(init.body));
        return realFetch(input, init);
      }) as typeof fetch;

      // ── 순수 판정 필드 스냅샷 (LLM 무관, 매 회차 같아야 정상) ──
      const route = routeQuestion(question, glossary, players, false);
      const ruleTerm = isSupportedRuleTermQuestion(question, glossary, players);
      const teams = mentionedTeamCanonicals(question);
      const rosterHit = mentionsAnyRosterName(question, players);
      const teamCandidate = resolveRagTeamCandidate(question);
      const teamServable = isTeamRagServableQuestion(question);

      // ── normalize seam 을 **직접** 태워 raw·verdict 를 본다 ──
      current = "normalize";
      let normRaw: string | null = null;
      try {
        normRaw = (await normalizeQuestionLlm(question)).text;
      } catch (e) {
        normRaw = `ERROR:${(e as Error).message.slice(0, 30)}`;
      }
      // 삼순 지적 그대로: null 도 동일문자열도 accepted=false 다. 그걸 명시적으로 계산한다.
      const verdict = normRaw === null
        ? "no_change"
        : normRaw === question ? "rejected_identical"
        : normRaw.normalize("NFKC") === question.normalize("NFKC") ? "nfkc_identical"
        : "candidate";

      // ── intent seam ──
      current = "intent";
      let intent = "-", clarify = "-", standalone = "-";
      try {
        const r = await classifyIntent(question);
        const d = parseIntentResponse(r.text, { question });
        intent = d.intent; clarify = d.clarify ?? "-"; standalone = String(d.standalone);
      } catch (e) {
        intent = `ERROR:${(e as Error).message.slice(0, 24)}`;
      }

      // ── 종단 실행 (production seam) ──
      current = "other";
      const c = { official: 0, player: 0, team: 0, generic: 0 };
      // 🔴 바깥에서 재계산한 판정은 "같아야 한다" 는 내 가정이 들어간다.
      //   각 seam 이 **실제로 받은 question 문자열**을 포획해, 파이프라인 내부에서
      //   질문이 바뀌었는지(정규화·교정 수용)를 직접 본다.
      const seenQuestions: Record<string, string[]> = { official: [], team: [] };
      const track = (r: LlmResult) => r;
      const deps = {
        loadGlossary: async () => glossary,
        loadPlayers: async () => players,
        getCache: async () => null,
        setCache: async () => {},
        callLlm: async (...a: Parameters<typeof callLlm>) => { c.generic += 1; return track(await callLlm(...a)); },
        mapGlossaryDefinition,
        normalizeQuestionLlm,
        pickedNormalizedQuestion: null,
        correctionDeclined: false,
        searchRag: async (...a: Parameters<typeof searchRag>) => {
          c.player += 1; seenQuestions.team.push(String(a[0]).slice(0, 40)); return searchRag(...a);
        },
        callRagLlm: async (...a: Parameters<typeof callRagLlm>) => track(await callRagLlm(...a)),
        enablePlayerRag: true,
        enableTeamRag: teamRagEnabled(),
        callTeamRagLlm: async (...a: Parameters<typeof callTeamRagLlm>) => { c.team += 1; return track(await callTeamRagLlm(...a)); },
        searchOfficialRag: async (q: string) => {
          c.official += 1; seenQuestions.official.push(q.slice(0, 40));
          // 게이트 조건을 **그 시점 question 으로** 재판정한다. 바깥 값과 다르면
          // 파이프라인이 다른 문자열을 들고 있었다는 뜻이다.
          seenQuestions.official.push(`gate:owned=${mentionsAnyRosterName(q, players) || mentionedTeamCanonicals(q).length > 0}/rule=${isSupportedRuleTermQuestion(q, glossary, players)}`);
          return searchOfficialRag(q);
        },
        callOfficialRagLlm: async (...a: Parameters<typeof callOfficialRagLlm>) => track(await callOfficialRagLlm(...a)),
        classifyIntent,
        reserveDaily: async () => ({ allowed: true, remaining: 999 }),
        log: async () => {},
      } as unknown as QaDeps;

      let source = "ERR";
      try {
        const r = await answerQuestion(`branch-${i}-${Math.random().toString(36).slice(2)}`, question, deps);
        source = (r as { source?: string }).source ?? "null";
      } catch (e) {
        source = `THROW:${(e as Error).message.slice(0, 24)}`;
      }
      globalThis.fetch = realFetch;

      snapshots.push({
        rep: i,
        // 순수 판정 (흔들리면 안 되는 것들)
        route, ruleTerm, teams: teams.join("+") || "-", rosterHit,
        teamCandidate: teamCandidate ?? "-", teamServable,
        // normalize seam
        normVerdict: verdict,
        normRawHash: normRaw === null ? "null" : sha(normRaw),
        normCodepoints: normRaw === null ? "-" : codepoints(normRaw).slice(0, 60),
        // intent seam
        intent, clarify, standalone,
        // 종단
        source, counters: { ...c }, seenQuestions,
        // seam 별 1:1 요청 해시 (이 run 것만)
        seamHashes: { intent: [...seam.intent], normalize: [...seam.normalize], other: seam.other.length },
      });
    }

    // ── 최초로 갈리는 필드 찾기 ────────────────────────────────────────
    const FIELD_ORDER = [
      "route", "ruleTerm", "teams", "rosterHit", "teamCandidate", "teamServable",
      "normVerdict", "normRawHash", "intent", "clarify", "standalone", "source",
    ] as const;
    const firstDiverging: string[] = [];
    for (const f of FIELD_ORDER) {
      const vals = new Set(snapshots.map((s) => JSON.stringify(s[f])));
      if (vals.size > 1) firstDiverging.push(`${f}=${[...vals].join("|")}`);
    }

    const sources = snapshots.map((s) => s.source as string);
    const uniqSources = [...new Set(sources)];
    const mark = uniqSources.length === 1 ? "✅" : "🔴";
    console.log(`${mark} ${question}`);
    console.log(`   source: ${JSON.stringify(sources.reduce<Record<string, number>>((a, s) => { a[s] = (a[s] ?? 0) + 1; return a; }, {}))}`);
    console.log(`   최초 분기 필드: ${firstDiverging.length ? firstDiverging.slice(0, 4).join("  ") : "없음(전 필드 동일)"}`);
    const nv = [...new Set(snapshots.map((s) => s.normVerdict))];
    console.log(`   normalize verdict: ${nv.join("|")} · route=${snapshots[0]!.route} ruleTerm=${snapshots[0]!.ruleTerm} teamCand=${snapshots[0]!.teamCandidate} servable=${snapshots[0]!.teamServable}\n`);

    rows.push({ question, snapshots, firstDiverging, uniqSources });
  }

  writeFileSync(OUT, JSON.stringify({
    at: new Date().toISOString(), reps: REPS, concurrency: 1,
    note: "삼순 2026-08-31: 순차 실행 · seam별 1:1 해시 · 최초 분기 필드 탐색. 수정 없음(진단 전용).",
    priorEvidenceInvalidated: {
      what: "intent-gate-evidence-20260831.json 의 bodyHashes",
      why: "동시 실행(conc=4)에서 전역 배열에 push 해 다른 run 요청이 섞임(몬스터월 3행 29/30/31개). 입력 동등성 증거로 사용 불가.",
    },
    rows,
  }, null, 1));
  console.log(`원장: ${OUT}`);
}

void main();
