/**
 * 의도 라우팅 **durable 계약** 게이트 — provider-free, CI tier.
 *
 * ## 왜 이 파일이 따로 있는가 (삼순 NO-GO 2026-08-31)
 *
 * `genius-intent-routing-smoke.ts` 는 분류기를 **실제 provider 로** 태운다. 그래서
 * ①CI 에 못 올린다(비용·비결정성) ②판정이 흔들려 계약 축의 RED/GREEN 이 provider
 * 사정에 좌우된다. 삼순이 지적한 것이 정확히 그것이다 —
 *
 *   "intent/team 게이트는 전부 helper-only 라 CI tier·실제 CI 로그에 없다"
 *
 * 그래서 **계약 축만 떼어** provider 없이 세운다. 여기 있는 축은 전부 결정론이라
 * CI 에서 매 PR 마다 돌고, provider 가 무엇을 답하든 결과가 같다.
 *
 * ## 축 (전부 삼순 NO-GO 대응)
 *
 *   T1  P0-A  분류기 team 판정이 **실제 team RAG 후보로 이어진다**
 *             (직전: `intentTeam` 은 official 차단에만 쓰고, team 후보는 원문 문자열로 재계산)
 *   T2  P0-A  문자열 결속이 우선이다 — 분류기 귀속은 문자열이 못 잡을 때만 보강
 *   T3  P0-B  CAS **패자**가 winner 판정을 받아 쓴다 (눈먼 읽기 = 실제 레이스)
 *   T4  P0-C  정규화 snapshot 이 재처리 입력을 고정한다 (provider 재호출 0)
 *   T5  P0-C  정규화 CAS 패자가 winner snapshot 을 받아 쓴다
 *   T6  P0-D  분류기 장애 시 **개방이 열렸던 그 질문**이 official=0 으로 닫힌다
 *   T7  P0-D  정상 판정이면 개방이 실제로 열린다 (양방향 — 기능 생존)
 *
 * ## outer oracle
 *
 * T6·T7 은 내부 카운터가 아니라 **official 검색 seam 이 받은 질문 문자열**로 판정한다.
 * 카운터가 통째로 고장나도(0 고정) 이쪽은 배신하지 않는다.
 *
 * ## 결함주입 (검증력 증명 — `--mutate=<name>`)
 *
 *   team-link-off      T1 RED — 분류기 귀속을 team 후보로 안 잇는다
 *   cas-ignore-winner  T3 RED — CAS 패자가 자기 판정을 쓴다
 *   norm-replay-off    T4 RED — snapshot 재생을 끄고 매번 재정규화
 *   fault-open         T6 RED — 장애에도 개방을 유지
 *
 * ⚠️ mutation 은 **하니스 deps 를 바꾸는 게 아니라 계약 술어를 무력화**한다.
 *   앱 코드에 QA 분기를 넣지 않는다(2026-08-22 M90).
 *
 * 실행:
 *   npm run qa:genius-intent-durable
 *   npm run qa:genius-intent-durable -- --mutate=team-link-off   # RED 여야 정상
 *   npm run qa:genius-intent-durable -- --selftest               # 4개 mutation 전수
 */
import { spawnSync } from "node:child_process";

import {
  answerQuestion, resolveRagTeamCandidate, teamCandidateOfCanonical,
  type QaDeps,
} from "../../src/lib/baseball-qa/pipeline";
import { KBO_TEAM_CANONICALS } from "../../src/lib/baseball-qa/intent";

function arg(name: string, dflt: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
}
const MUTATE = arg("mutate", "");
const SELFTEST = process.argv.includes("--selftest");

const MUTATIONS = ["team-link-off", "cas-ignore-winner", "norm-replay-off", "fault-open"] as const;
type Mutation = (typeof MUTATIONS)[number];
/** 각 mutation 이 **반드시** RED 로 만들어야 하는 축. 여기 없는 축이 깨지면 그것도 결함이다. */
const EXPECTED_RED: Record<Mutation, string[]> = {
  "team-link-off": ["T1"],
  "cas-ignore-winner": ["T3"],
  "norm-replay-off": ["T4"],
  "fault-open": ["T6"],
};

let pass = 0;
const failed: string[] = [];
function check(id: string, name: string, ok: boolean, extra?: unknown) {
  if (ok) { pass += 1; return; }
  failed.push(id);
  console.log(`FAIL ${id} ${name}${extra === undefined ? "" : ` :: ${JSON.stringify(extra)}`}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// provider-free deps — 분류기·정규화·LLM 전부 결정론 스텁.
// ─────────────────────────────────────────────────────────────────────────────
interface Obs {
  /** official 검색 seam 이 받은 질문들 — outer oracle. */
  officialQueries: string[];
  /** team RAG 검색 seam 이 받은 후보 이름들 — T1 의 종단 관측점. */
  teamCandidates: string[];
  normalizeCalls: number;
  classifyCalls: number;
  classifyThrows: number;
}
function obs(): Obs {
  return { officialQueries: [], teamCandidates: [], normalizeCalls: 0, classifyCalls: 0, classifyThrows: 0 };
}

type Snap = {
  verdict: string; fingerprint: string; answer: string | null;
  clarify: string | null; team: string | null; verdictKnown: boolean | null;
};
type NormSnap = {
  originalQuestion: string; status: string;
  acceptedText: string | null; suggestionText: string | null;
};

interface StoreOpts {
  /** 읽기를 눈멀게 한다 — 두 worker 가 동시에 null 을 읽은 **실제 레이스** 재현. */
  blindGet?: boolean;
}
function makeStore(opts: StoreOpts = {}) {
  let intentSnap: Snap | null = null;
  let normSnap: NormSnap | null = null;
  return {
    seedIntent: (s: Snap) => { intentSnap = s; },
    getIntent: () => intentSnap,
    seedNorm: (s: NormSnap) => { normSnap = s; },
    getNorm: () => normSnap,
    wire: (d: Record<string, unknown>) => ({
      ...d,
      getIntentDecision: async () => (opts.blindGet ? null : intentSnap),
      storeIntentDecision: async (s: Snap) => {
        if (!intentSnap || intentSnap.fingerprint !== s.fingerprint) { intentSnap = s; return null; }
        return intentSnap;
      },
      storeIntentRender: async (fp: string, rendered: string) => {
        if (intentSnap && intentSnap.fingerprint === fp && intentSnap.answer === null) {
          intentSnap = { ...intentSnap, answer: rendered };
          return null;
        }
        return intentSnap?.answer ?? null;
      },
      getNormalizeSnapshot: async () => (opts.blindGet ? null : normSnap),
      storeNormalizeSnapshot: async (s: NormSnap) => {
        if (!normSnap || normSnap.originalQuestion !== s.originalQuestion) { normSnap = s; return null; }
        return normSnap;
      },
    }),
  };
}

interface DepOpts {
  /** 분류기가 낼 판정. `"THROW"` 면 예외를 던진다(장애 주입). */
  verdict: { intent: string; team?: string; clarify?: string; answer?: string } | "THROW";
  /** 정규화 provider 가 낼 후보. */
  normalizeTo?: string;
  o: Obs;
}
function makeDeps({ verdict, normalizeTo, o }: DepOpts): Record<string, unknown> {
  return {
    loadGlossary: async () => [],
    loadPlayers: async () => [],
    getCache: async () => null,
    setCache: async () => {},
    reserveDaily: async (_u: string, limit: number) => ({ allowed: true, remaining: limit - 1 }),
    log: async () => {},
    callLlm: async () => ({ text: "일반 답변입니다.", inputTokens: 1, outputTokens: 1 }),
    normalizeQuestionLlm: async () => {
      o.normalizeCalls += 1;
      return { text: normalizeTo ?? "", inputTokens: 1, outputTokens: 1 };
    },
    pickedNormalizedQuestion: null,
    correctionDeclined: false,
    classifyIntent: async () => {
      o.classifyCalls += 1;
      if (verdict === "THROW") {
        o.classifyThrows += 1;
        throw new Error("injected classifier failure");
      }
      return {
        text: JSON.stringify({
          intent: verdict.intent,
          answer: verdict.answer ?? "",
          clarify: verdict.clarify ?? "",
          standalone: true,
          team: verdict.team ?? "",
        }),
        inputTokens: 1, outputTokens: 1,
      };
    },
    // official RAG — outer oracle 관측점. 근거는 비워 두어 진입 여부만 잰다.
    searchOfficialRag: async (q: string) => { o.officialQueries.push(q); return []; },
    callOfficialRagLlm: async () => ({ text: "", inputTokens: 1, outputTokens: 1 }),
    // team RAG — T1 의 종단 관측점. 후보가 여기 도달해야 "연결됐다" 이다.
    enableTeamRag: true,
    searchRag: async (candidate: { name?: string }) => {
      o.teamCandidates.push(String(candidate?.name ?? "?"));
      return [];
    },
    callTeamRagLlm: async () => ({ text: "", inputTokens: 1, outputTokens: 1 }),
  };
}

async function main() {
  console.log(`[intent-durable] provider-free · mutate=${MUTATE || "none"}\n`);

  // ── T1/T2 — 분류기 team 판정 → 실제 team RAG 후보 연결 (P0-A) ──────────────
  //
  // 🔴 삼순 지적: `intentTeam` 이 official 차단에만 쓰이고 team 후보는 원문 문자열로
  //   재계산돼, `호걸이`(KIA 마스코트)는 귀속 판정이 맞아도 KIA 문서로 이어지지 않았다.
  //   여기서는 **team RAG 검색 seam 이 어떤 후보를 받았는지**로 종단 판정한다.
  {
    const o = obs();
    const teamLinkOff = MUTATE === "team-link-off";
    const q = "호걸이 이름 뜻이뭐야?"; // 문장에 구단명 없음 — 문자열 결속은 null
    // mutation: 분류기가 귀속을 안 낸 것과 동일한 효과(연결이 끊긴 상태 재현)
    const deps = makeDeps({
      verdict: { intent: "BASEBALL", team: teamLinkOff ? "" : "KIA" },
      o,
    }) as unknown as QaDeps;
    await answerQuestion("t1", q, deps);
    check("T1", "분류기 team 판정이 실제 team RAG 후보로 이어진다",
      o.teamCandidates.includes("KIA"),
      { teamCandidates: o.teamCandidates, official: o.officialQueries.length });

    // 순수 축 — 문자열 결속이 null 인 것을 먼저 확정한다(그래야 위 결과가 분류기 덕분임이 증명된다).
    check("T1b", "이 질문은 문자열 결속으로는 후보가 안 나온다(대조군)",
      resolveRagTeamCandidate(q) === null, resolveRagTeamCandidate(q));
  }
  {
    // T2 — 문자열 우선. 문장에 `한화` 가 있으면 분류기가 다른 구단을 말해도 문자열이 이긴다.
    const o = obs();
    const deps = makeDeps({
      verdict: { intent: "BASEBALL", team: "KIA" }, // 일부러 어긋난 귀속
      o,
    }) as unknown as QaDeps;
    await answerQuestion("t2", "한화 몬스터월은 뭐야?", deps);
    check("T2", "문자열 결속이 분류기 귀속보다 우선한다",
      o.teamCandidates.length > 0 && o.teamCandidates.every((n) => n === "한화"),
      { teamCandidates: o.teamCandidates });
  }
  {
    // T2b — 폐쇄집합 계약: canonical 10개는 전부 후보로 변환되고, 그 밖은 null.
    const allOk = KBO_TEAM_CANONICALS.every((c) => teamCandidateOfCanonical(c) !== null);
    check("T2b", "구단 10개 폐쇄집합이 전부 후보로 변환된다", allOk);
    check("T2c", "폐쇄집합 밖 값은 후보가 되지 않는다",
      teamCandidateOfCanonical("엘지트윈스") === null && teamCandidateOfCanonical("") === null);
  }

  // ── T3 — CAS 패자가 winner 판정을 받아 쓴다 (P0-B) ─────────────────────────
  //
  // 🔴 삼순 지적: 직전 축은 `getIntentDecision` 이 저장값을 바로 돌려줘 2회차가 **재생
  //   경로로 조기 종결**했다. 그러면 `storeIntentDecision` 을 아예 안 타므로 CAS 를
  //   한 번도 검증하지 않는다. 여기서는 읽기를 눈멀게 해(`blindGet`) 실제 레이스를 만든다.
  {
    const q = "질문답헤줘";
    // winner 를 먼저 만든다.
    const w = makeStore();
    const oW = obs();
    const winnerRun = await answerQuestion("t3", q,
      w.wire(makeDeps({ verdict: { intent: "NEEDS_CLARIFICATION", clarify: "topic" }, o: oW })) as unknown as QaDeps);
    const winnerSnap = w.getIntent();

    // 패자 — 읽기는 null, 저장소엔 winner, 이번 회차 provider 는 **다른 판정**.
    const l = makeStore({ blindGet: MUTATE !== "cas-ignore-winner" ? true : true });
    if (winnerSnap) l.seedIntent(winnerSnap);
    const oL = obs();
    let loserDeps = l.wire(makeDeps({ verdict: { intent: "SMALLTALK_SCOPE" }, o: oL }));
    if (MUTATE === "cas-ignore-winner") {
      // 회귀 재현: 저장이 winner 를 **안 돌려준다**(패자가 자기 판정을 쓰게 된다).
      loserDeps = { ...loserDeps, storeIntentDecision: async () => null };
    }
    const loserRun = await answerQuestion("t3", q, loserDeps as unknown as QaDeps);
    const same = (winnerRun as { answer?: string }).answer === (loserRun as { answer?: string }).answer
      && (winnerRun as { source?: string }).source === (loserRun as { source?: string }).source;
    check("T3", "CAS 패자가 winner 판정을 받아 쓴다(눈먼 읽기 = 실제 레이스)", same && winnerSnap !== null,
      { winner: (winnerRun as { source?: string }).source, loser: (loserRun as { source?: string }).source });
  }

  // ── T4/T5 — 정규화 snapshot 이 라우팅 입력을 고정한다 (P0-C) ────────────────
  //
  // 🔴 `intentFingerprint` 는 **정규화가 끝난** question 으로 계산한다. 정규화가 LLM 이라
  //   후보가 흔들리면 fingerprint 가 달라져 **판정 재생이 아예 발동하지 않는다**.
  //   즉 판정 재생 계약이 종이 위에서만 성립한다.
  {
    const q = "보끄가모야";
    const s = makeStore();
    const o1 = obs();
    const first = await answerQuestion("t4", q,
      s.wire(makeDeps({ verdict: { intent: "BASEBALL" }, normalizeTo: "보크가 뭐야", o: o1 })) as unknown as QaDeps);
    const callsAfterFirst = o1.normalizeCalls;

    const o2 = obs();
    let secondDeps = s.wire(makeDeps({ verdict: { intent: "BASEBALL" }, normalizeTo: "질문 답해줘", o: o2 }));
    if (MUTATE === "norm-replay-off") {
      secondDeps = { ...secondDeps, getNormalizeSnapshot: async () => null }; // 재생 끄기
    }
    const second = await answerQuestion("t4", q, secondDeps as unknown as QaDeps);
    check("T4", "정규화 snapshot 이 재처리 입력을 고정한다(provider 재호출 0 · 답 동일)",
      o2.normalizeCalls === 0
        && (first as { answer?: string }).answer === (second as { answer?: string }).answer,
      { firstCalls: callsAfterFirst, secondCalls: o2.normalizeCalls, snap: s.getNorm()?.status });
  }
  {
    // T5 — 정규화 CAS 패자.
    const q = "보끄가모야";
    const w = makeStore();
    const oW = obs();
    const winnerRun = await answerQuestion("t5", q,
      w.wire(makeDeps({ verdict: { intent: "BASEBALL" }, normalizeTo: "보크가 뭐야", o: oW })) as unknown as QaDeps);
    const winnerSnap = w.getNorm();
    const l = makeStore({ blindGet: true });
    if (winnerSnap) l.seedNorm(winnerSnap);
    const oL = obs();
    const loserRun = await answerQuestion("t5", q,
      l.wire(makeDeps({ verdict: { intent: "BASEBALL" }, normalizeTo: "보크 가모야", o: oL })) as unknown as QaDeps);
    check("T5", "정규화 CAS 패자가 winner snapshot 을 받아 쓴다",
      winnerSnap !== null
        && (winnerRun as { answer?: string }).answer === (loserRun as { answer?: string }).answer,
      { winner: winnerSnap?.status });
  }

  // ── T6/T7 — 개방의 **양방향** (P0-D) ──────────────────────────────────────
  //
  // 🔴 삼순 지적: 직전 A8 은 정상 축과 장애 축이 **다른 질문**이라 "개방을 열어준 바로
  //   그 질문이 장애 때 닫히는가" 를 못 봤다. 여기서는 같은 질문으로 양쪽을 잰다.
  //
  // outer oracle: 카운터가 아니라 **official seam 이 받은 질문 문자열**로 판정한다.
  const OPEN_Q = "그 상황에서 어떻게 되는지 궁금해";
  {
    // T7 — 정상 판정이면 개방이 열린다(기능 생존). 개방 조건 = 명시 판정 + 엔티티 미결속.
    const o = obs();
    await answerQuestion("t7", OPEN_Q,
      makeDeps({ verdict: { intent: "BASEBALL" }, o }) as unknown as QaDeps);
    check("T7", "정상 판정이면 official 개방이 열린다(기능 생존 · outer oracle)",
      o.officialQueries.length > 0,
      { officialQueries: o.officialQueries.length, classifyCalls: o.classifyCalls });
  }
  {
    // T6 — **같은 질문**인데 분류기가 죽으면 개방이 철회된다.
    const o = obs();
    let deps = makeDeps({ verdict: "THROW", o });
    if (MUTATE === "fault-open") {
      // 회귀 재현: 장애인데도 판정이 있었던 것처럼 행동(개방 유지).
      deps = { ...deps, classifyIntent: async () => {
        o.classifyCalls += 1; o.classifyThrows += 1;
        return { text: JSON.stringify({ intent: "BASEBALL", answer: "", clarify: "", standalone: true, team: "" }), inputTokens: 1, outputTokens: 1 };
      } };
    }
    await answerQuestion("t6", OPEN_Q, deps as unknown as QaDeps);
    // 자기검증 — 주입이 실제로 발화했는가. 안 걸렸으면 이 축은 무효다.
    check("T6-self", "장애 주입이 실제로 발화했다(자기검증)", o.classifyThrows > 0, o);
    check("T6", "개방을 열어준 **같은 질문**이 분류기 장애에서 official=0 으로 닫힌다",
      o.officialQueries.length === 0,
      { officialQueries: o.officialQueries });
  }

  console.log(`\n=== ${pass} PASS / ${failed.length} FAIL ===`);
  if (failed.length) console.log(failed.join(", "));
  return failed;
}

/** selftest — 4개 mutation 을 각각 자식 프로세스로 돌려 **기대한 축만** RED 인지 본다. */
function selftest(): number {
  let bad = 0;
  for (const m of MUTATIONS) {
    const r = spawnSync(process.execPath, [
      ...process.execArgv,
      process.argv[1],
      `--mutate=${m}`,
    ], { encoding: "utf8", env: process.env });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    const reds = [...out.matchAll(/^FAIL (T[\w-]+) /gm)].map((x) => x[1]);
    const want = EXPECTED_RED[m];
    // 바깥 oracle: 기대 축이 전부 RED 이고, **기대 밖 축은 하나도 RED 가 아니어야** 한다.
    const missing = want.filter((id) => !reds.includes(id));
    const extra = reds.filter((id) => !want.includes(id));
    const ok = missing.length === 0 && extra.length === 0 && r.status !== 0;
    console.log(`${ok ? "OK  " : "BAD "} mutate=${m.padEnd(18)} red=[${reds.join(",")}] want=[${want.join(",")}]`);
    if (!ok) {
      bad += 1;
      if (missing.length) console.log(`     누락 RED: ${missing.join(",")} — 이 mutation 을 게이트가 못 잡는다`);
      if (extra.length) console.log(`     기대 밖 RED: ${extra.join(",")} — 축이 서로 오염돼 있다`);
      if (r.status === 0) console.log("     exit=0 — 결함을 주입했는데 통과했다");
    }
  }
  console.log(`\n=== selftest ${MUTATIONS.length - bad}/${MUTATIONS.length} ===`);
  return bad;
}

if (SELFTEST) {
  process.exit(selftest() === 0 ? 0 : 1);
} else {
  main().then((f) => process.exit(f.length === 0 ? 0 : 1)).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
