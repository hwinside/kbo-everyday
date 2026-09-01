/**
 * 게이트: frames-stale(stale-equal) 관측 마커 — 2026-09-01 LG:OB 볼카운트 고착 조사 후속.
 *
 * 계약: relay 퍼블리셔가 "fetch 성공 + 내용 동일(hash 일치)" 로 발행을 skip 하는 연속
 * 구간(stale-equal, mode B)을 `<gameId>:frames-stale=<streak>` 마커로 warmup_enrich_obs
 * 에 남긴다. 축:
 *  S1 streak 증가는 relay 채널 무변경에서만 (events/live/detail 무변경은 불가산)
 *  S2 발행 지점은 임계(20)+배증(40,80,…)에서만 — 임계 초과 구간 틱마다 행 폭주 금지(양방향)
 *  S3 relay inserted 에서만 0 리셋
 *  S4 fetch 실패·abort 는 증가도 리셋도 없음 (무변경 "관측"이 아님)
 *  S5 insert 거부(stale/lock_busy/error)도 증가·리셋 없음
 *  S6 Redis 상태 round-trip 보존 + 레거시 상태(필드 부재) → 0 (cron 경계 지속)
 *  S7 selectEmergentObsTicks 가 frames-stale= prefix 마커를 발현으로 판정(양방향)
 *  S8 persistWarmupEnrichObs 실적재: tick_kind='publisher' 행 + 무발현 시 insert 0 (주입 admin,
 *     production seam — 게이트가 사본이 아니라 실제 persist 함수를 태운다)
 *  S9 route 배선: 마커 수집 + persist 호출이 실제 소스에 존재 + **owner→state SET→적재 순서**
 *     (주석 blank 처리 후 구조 판정)
 *  S10 degraded-200 불가산(삼순 NO-GO ①): producer 실 seam(buildRelayJsonResponse)을
 *     직접 실행해 degraded/fresh 응답 헤더 양방향 검증(헤더 삭제·오타 mutation 실행 RED)
 *     + producer 응답을 그대로 consumer(publishGameTick)에 먹여 불가산·불리셋 검증
 *     + game-relay 배선 구조 판정(fresh-miss 경로가 이 seam 만 쓴다)
 *  S11 적재 허용 선별(삼순 NO-GO ②): 실 seam(saveStatesAndSelectPersistable — route 가
 *     쓰는 바로 그 함수, `=== "OK"` 판정 내장)에 SET 실패(null/"ERR"/throw)·lock-lost·
 *     비소유 결함주입 — 해당 마커 탈락(RED) + 비소유 시 SET 무호출(stale writer 보호)
 *
 * env 불필요(더미 선주입). 실패 시 exit 1.
 */
import { readFileSync } from "node:fs";
import type {
  PersistedGameState,
  RelayInsertOutcome,
  TickDeps,
} from "../../src/lib/game/relay-live-publisher.ts";

process.env.NEXT_PUBLIC_SUPABASE_URL ||= "http://127.0.0.1:1";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "ci-dummy-service-role-not-used";

const {
  publishGameTick,
  newGameState,
  serializeState,
  deserializeState,
  shouldEmitFramesStale,
  selectPersistableStaleMarkers,
  saveStatesAndSelectPersistable,
  FRAMES_STALE_THRESHOLD_TICKS,
  RELAY_DEGRADED_HEADER,
} = await import("../../src/lib/game/relay-live-publisher.ts");
const { buildRelayJsonResponse } = await import("../../src/lib/game/relay-degraded-header.ts");
const { selectEmergentObsTicks, persistWarmupEnrichObs } = await import(
  "../../src/lib/notifications/warmup-enrich-obs.ts"
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail: unknown = ""): void {
  if (ok) { pass += 1; console.log(`ok - ${name}`); }
  else { fail += 1; console.error(`FAIL - ${name} :: ${JSON.stringify(detail)}`); }
}

function relayResponse(marker: number, httpOk = true, degraded = false): Response {
  // degraded 시 consumer 테스트도 producer 실 seam(buildRelayJsonResponse)으로 응답을
  // 만든다 — 게이트가 헤더를 직접 조립하면 producer 삭제/오타 mutation 이 GREEN 으로
  // 숨는다(삼순 3차 false-green 지적).
  if (!httpOk) return new Response("upstream fail", { status: 502 });
  return buildRelayJsonResponse({ innings: [{ inning: 1, marker }] }, { "content-type": "application/json" }, degraded) as unknown as Response;
}

function makeDeps(outcome: RelayInsertOutcome, marker: number, httpOk = true, degraded = false): TickDeps {
  const handler = (): Promise<Response> => Promise.resolve(relayResponse(marker, httpOk, degraded));
  return {
    handlers: { relay: handler, events: handler, live: handler, detail: handler },
    insertFrame: (): Promise<RelayInsertOutcome> => Promise.resolve(outcome),
    epoch: 1,
    date: "2026-09-01",
  };
}

/** relay 단독 tickIndex (1%5,1%3,1%10 모두 ≠0 → channels=['relay']). */
const RELAY_ONLY_TICK = 1;

async function run() {
  const T = FRAMES_STALE_THRESHOLD_TICKS;

  // ── S2(순수): 발행 지점 판정 양방향 ─────────────────────────────────────────────
  check("S2 순수: 임계 미만 전부 false", ![...Array(T).keys()].some((n) => shouldEmitFramesStale(n)), T);
  check("S2 순수: 임계 정확히 true", shouldEmitFramesStale(T) === true, T);
  check("S2 순수: 임계+1 ~ 배증-1 false", !shouldEmitFramesStale(T + 1) && !shouldEmitFramesStale(2 * T - 1), T);
  check("S2 순수: 배증(2T,4T) true / 3T false", shouldEmitFramesStale(2 * T) && shouldEmitFramesStale(4 * T) && !shouldEmitFramesStale(3 * T), T);

  // ── S1+S2+S3: 실제 publishGameTick 흐름으로 임계 도달 → 발행 → inserted 리셋 ──────
  {
    const state: PersistedGameState = newGameState();
    // 1st tick: 첫 발행(inserted) → streak 0
    await publishGameTick(makeDeps("inserted", 1), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S1 첫 발행 후 streak 0", state.relayUnchangedStreak === 0, state.relayUnchangedStreak);
    // 무변경 T회 반복 → 정확히 T번째에서 발현
    const emits: number[] = [];
    for (let i = 0; i < T; i++) {
      const r = await publishGameTick(makeDeps("inserted", 1), state, "g1", RELAY_ONLY_TICK, undefined);
      if (r.framesStaleStreak !== null) emits.push(r.framesStaleStreak);
    }
    check("S1 무변경 T회 → streak T", state.relayUnchangedStreak === T, state.relayUnchangedStreak);
    check("S2 발행 1회, 값=T (임계 지점 단발)", emits.length === 1 && emits[0] === T, emits);
    // T+1 ~ 2T-1 무발행, 2T 에서 재발행
    const emits2: number[] = [];
    for (let i = 0; i < T; i++) {
      const r = await publishGameTick(makeDeps("inserted", 1), state, "g1", RELAY_ONLY_TICK, undefined);
      if (r.framesStaleStreak !== null) emits2.push(r.framesStaleStreak);
    }
    check("S2 배증 재발행 1회, 값=2T", emits2.length === 1 && emits2[0] === 2 * T, emits2);
    // 내용 변경 → inserted → 리셋
    await publishGameTick(makeDeps("inserted", 2), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S3 내용 변경 inserted → streak 0 리셋", state.relayUnchangedStreak === 0, state.relayUnchangedStreak);
  }

  // ── S1(비relay 불가산): 4채널 tick 에서 relay 만 변경, 나머지 무변경 반복 ────────────
  {
    const state: PersistedGameState = newGameState();
    // tickIndex 0 = 4채널 전부. 같은 내용 2회 → 2회차에 4채널 모두 무변경.
    await publishGameTick(makeDeps("inserted", 10), state, "g1", 0, undefined);
    const before = state.relayUnchangedStreak;
    const r = await publishGameTick(makeDeps("inserted", 10), state, "g1", 0, undefined);
    check("S1 4채널 무변경 tick: skippedUnchanged 4", r.skippedUnchanged === 4, r.skippedUnchanged);
    check("S1 relay 무변경만 가산(+1) — events/live/detail 은 불가산", state.relayUnchangedStreak === before + 1, { before, after: state.relayUnchangedStreak });
  }

  // ── S4: fetch 실패·abort 는 증가·리셋 없음 ────────────────────────────────────────
  {
    const state: PersistedGameState = newGameState();
    await publishGameTick(makeDeps("inserted", 20), state, "g1", RELAY_ONLY_TICK, undefined);
    await publishGameTick(makeDeps("inserted", 20), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S4 사전: streak 1", state.relayUnchangedStreak === 1, state.relayUnchangedStreak);
    await publishGameTick(makeDeps("inserted", 20, false), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S4 fetch 실패(!ok): streak 불변", state.relayUnchangedStreak === 1, state.relayUnchangedStreak);
    const ac = new AbortController();
    ac.abort();
    await publishGameTick(makeDeps("inserted", 20), state, "g1", RELAY_ONLY_TICK, ac.signal);
    check("S4 abort tick: streak 불변", state.relayUnchangedStreak === 1, state.relayUnchangedStreak);
  }

  // ── S5: insert 거부(stale/lock_busy/error)는 증가·리셋 없음 ──────────────────────
  {
    for (const outcome of ["stale", "lock_busy", "error"] as const) {
      const state: PersistedGameState = newGameState();
      await publishGameTick(makeDeps("inserted", 30), state, "g1", RELAY_ONLY_TICK, undefined);
      await publishGameTick(makeDeps("inserted", 30), state, "g1", RELAY_ONLY_TICK, undefined);
      const before = state.relayUnchangedStreak;
      // 내용은 바뀌었지만 insert 가 거부됨 — 무변경 관측이 아니므로 streak 불변이어야 한다.
      await publishGameTick(makeDeps(outcome, 31), state, "g1", RELAY_ONLY_TICK, undefined);
      check(`S5 insert ${outcome}: streak 불변(증가·리셋 없음)`, state.relayUnchangedStreak === before, { outcome, before, after: state.relayUnchangedStreak });
    }
  }

  // ── S6: Redis round-trip + 레거시 상태 호환 ──────────────────────────────────────
  {
    const state: PersistedGameState = newGameState();
    state.relayUnchangedStreak = 7;
    const revived = deserializeState(serializeState(state));
    check("S6 round-trip: streak 보존", revived.relayUnchangedStreak === 7, revived.relayUnchangedStreak);
    const legacy = deserializeState(JSON.stringify({ lastHash: {}, relayChanges: 3, seq: 5, publishedFull: true }));
    check("S6 레거시 상태(필드 부재): streak 0 + 기존 필드 보존", legacy.relayUnchangedStreak === 0 && legacy.seq === 5 && legacy.publishedFull === true, legacy);
    const negative = deserializeState(JSON.stringify({ relayUnchangedStreak: -4 }));
    check("S6 음수 방어: 0 으로 정규화", negative.relayUnchangedStreak === 0, negative.relayUnchangedStreak);
  }

  // ── S7: 발현 판정 양방향 ────────────────────────────────────────────────────────
  {
    const stale = { atMs: 1, tickKind: "publisher" as const, liveSource: "relay-publisher", liveStage: "relay-publisher", obs: ["20260901LGOB0:frames-stale=20"] };
    const normal = { atMs: 2, tickKind: "subtick" as const, liveSource: "naver", liveStage: "naver", obs: ["20260901LGOB0:score-src=relay"] };
    const picked = selectEmergentObsTicks([stale, normal]);
    check("S7 frames-stale= prefix → 발현 판정", picked.length === 1 && picked[0] === stale, picked.length);
    const decoy = { ...stale, obs: ["20260901LGOB0:frames-stale-ish"] };
    check("S7 prefix 불일치(decoy) → 비발현", selectEmergentObsTicks([decoy]).length === 0, decoy.obs);
  }

  // ── S8: persist production seam 실적재 (주입 admin) ──────────────────────────────
  {
    const inserted: Array<Record<string, unknown>> = [];
    const admin = {
      from() {
        return {
          insert(rows: unknown[]) {
            inserted.push(...(rows as Array<Record<string, unknown>>));
            return Promise.resolve({ error: null });
          },
          delete() { return { lt: () => Promise.resolve({}) }; },
        };
      },
    };
    const result = await persistWarmupEnrichObs(
      [{ atMs: 123, tickKind: "publisher", liveSource: "relay-publisher", liveStage: "relay-publisher", obs: ["g1:frames-stale=40"] }],
      // nowMs 분!=0 → GC 비활성 경로 고정
      Date.UTC(2026, 8, 1, 12, 30, 0),
      () => admin,
    );
    check("S8 persist: persisted 1", "persisted" in result && result.persisted === 1, result);
    check("S8 persist: tick_kind='publisher' + 마커 원문 적재", inserted.length === 1 && inserted[0].tick_kind === "publisher" && Array.isArray(inserted[0].obs) && (inserted[0].obs as string[])[0] === "g1:frames-stale=40", inserted);
    const before = inserted.length;
    const none = await persistWarmupEnrichObs(
      [{ atMs: 124, tickKind: "subtick", liveSource: "naver", liveStage: "naver", obs: ["g1:score-src=relay"] }],
      Date.UTC(2026, 8, 1, 12, 30, 0),
      () => admin,
    );
    check("S8 무발현: insert 0 (행 없음 계약)", "persisted" in none && none.persisted === 0 && inserted.length === before, none);
  }

  // ── S9: route 배선 구조 판정 (주석 blank 처리 — 주석 문면이 assertion 을 못 만족시키게) ──
  {
    const raw = readFileSync(
      new URL("../../src/app/api/cron/relay-live-publisher/route.ts", import.meta.url),
      "utf8",
    );
    const src = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^[ \t]*\/\/[^\n]*/gm, (m) => " ".repeat(m.length));
    const collects = /framesStaleMarkers\.push\(\s*`\$\{gameIds\[i\]\}:frames-stale=\$\{r\.framesStaleStreak\}`/.test(src);
    const persists = /persistWarmupEnrichObs\(\[/.test(src) && /tickKind:\s*"publisher"/.test(src);
    const guarded = /persistableMarkers\.length\s*\?/.test(src);
    check("S9 route: tick 결과 → 마커 수집 배선 존재", collects, collects);
    check("S9 route: persistWarmupEnrichObs(publisher tick) 호출 존재", persists, persists);
    check("S9 route: 적재허용 마커 0건이면 무호출 가드", guarded, guarded);
    // 순서 계약(삼순 NO-GO ②): owner 확인(stillOwner) → state 저장+선별 seam
    // (saveStatesAndSelectPersistable) → persist 호출이 소스 순서상 이 순서여야 한다.
    const iOwner = src.indexOf("const stillOwner");
    const iSeam = src.indexOf("await saveStatesAndSelectPersistable({");
    const iPersist = src.indexOf("persistWarmupEnrichObs([");
    const ordered = iOwner >= 0 && iSeam > iOwner && iPersist > iSeam;
    check("S9 route: owner→state 저장/선별 seam→적재 순서", ordered, { iOwner, iSeam, iPersist });
    const selectorWired = /lockLost,\s*\n?\s*stillOwner,/.test(src) && /markers: framesStaleMarkers,/.test(src);
    check("S9 route: seam 이 lockLost·stillOwner·수집 마커 실값에 결속", selectorWired, selectorWired);
  }

  // ── S10: degraded-200 불가산 (삼순 NO-GO ①) — producer 실 seam 실행 + consumer 결속 ──
  {
    // (a) producer seam 직접 실행: degraded/fresh 응답 헤더 양방향. 헤더 삭제·오타
    //     mutation 은 여기서 실행으로 RED(구조판정 의존 아님).
    const degradedRes = buildRelayJsonResponse({ ok: 1 }, { "cache-control": "no-store" }, true);
    const freshRes = buildRelayJsonResponse({ ok: 1 }, { "cache-control": "no-store" }, false);
    check("S10-a producer 실행: degraded → 헤더 '1'", degradedRes.headers.get(RELAY_DEGRADED_HEADER) === "1", degradedRes.headers.get(RELAY_DEGRADED_HEADER));
    check("S10-a producer 실행: fresh → 헤더 부재", freshRes.headers.get(RELAY_DEGRADED_HEADER) === null, freshRes.headers.get(RELAY_DEGRADED_HEADER));
    check("S10-a producer 실행: 기존 cache 헤더 보존", degradedRes.headers.get("cache-control") === "no-store", degradedRes.headers.get("cache-control"));

    // (b) consumer 결속: producer seam 이 만든 응답을 그대로 publishGameTick 에 먹인다
    //     (relayResponse 가 buildRelayJsonResponse 를 경유 — producer↔consumer 헤더 불일치는
    //      여기서 즉시 RED).
    const state: PersistedGameState = newGameState();
    await publishGameTick(makeDeps("inserted", 50), state, "g1", RELAY_ONLY_TICK, undefined);
    await publishGameTick(makeDeps("inserted", 50), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S10-b 대조군: fresh 무변경 → streak +1", state.relayUnchangedStreak === 1, state.relayUnchangedStreak);
    const r = await publishGameTick(makeDeps("inserted", 50, true, true), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S10-b degraded 무변경: streak 불가산(불변)", state.relayUnchangedStreak === 1, state.relayUnchangedStreak);
    check("S10-b degraded 무변경: skippedUnchanged 집계는 유지(발행 안 함)", r.skippedUnchanged === 1, r.skippedUnchanged);
    check("S10-b degraded 무변경: 발현 없음", r.framesStaleStreak === null, r.framesStaleStreak);
    await publishGameTick(makeDeps("inserted", 50), state, "g1", RELAY_ONLY_TICK, undefined);
    check("S10-b degraded 해소 후 fresh 무변경: 재가산 +1", state.relayUnchangedStreak === 2, state.relayUnchangedStreak);

    // (c) game-relay 배선 구조 판정(주석 blank): fresh-miss 반환 경로가 producer seam 을
    //     실제 anyInningDegraded 로 호출하고, 그 경로에 NextResponse.json 직접 호출이 없다.
    const rawRelay = readFileSync(
      new URL("../../src/app/api/game-relay/route.ts", import.meta.url),
      "utf8",
    );
    const relaySrc = rawRelay
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^[ \t]*\/\/[^\n]*/gm, (m) => " ".repeat(m.length));
    const wired = /return buildRelayJsonResponse\(\s*toDeltaResponse\(response, sinceInning\),\s*liveCacheHeaders\([^)]*\),\s*anyInningDegraded,\s*\)/.test(relaySrc);
    check("S10-c game-relay: fresh-miss 경로가 producer seam+실값 anyInningDegraded 배선", wired, wired);
    const directJson = /NextResponse\.json\(toDeltaResponse\(response, sinceInning\)/.test(relaySrc);
    check("S10-c game-relay: 이 경로 NextResponse.json 직접 호출 없음(우회 금지)", !directJson, directJson);
  }

  // ── S11: 적재 허용 선별 — 실 seam(saveStatesAndSelectPersistable) 결함주입 ──
  {
    const markers = ["g1:frames-stale=20", "g2:frames-stale=40"];
    const base = {
      gameIds: ["g1", "g2"],
      serializedStateFor: () => "{}",
      lockLost: false,
      stillOwner: true,
      markers,
    };
    // 대조군: 전경기 SET OK → 전마커 허용
    const ok = await saveStatesAndSelectPersistable({ ...base, setState: async () => "OK" });
    check("S11 대조군(SET 전부 OK): 전마커 허용", ok.persistable.length === 2, ok.persistable);
    // SET 실패 결함주입 3종 — route 가 쓰는 바로 그 seam 의 `=== "OK"` 판정을 실행으로 태운다.
    const nullFail = await saveStatesAndSelectPersistable({ ...base, setState: async (g) => (g === "g1" ? null : "OK") });
    check("S11 SET null(g1) 주입: g1 탈락·g2 유지(RED)", nullFail.persistable.length === 1 && nullFail.persistable[0] === "g2:frames-stale=40", nullFail.persistable);
    const errFail = await saveStatesAndSelectPersistable({ ...base, setState: async (g) => (g === "g2" ? "ERR" : "OK") });
    check("S11 SET 비-OK(g2) 주입: g2 탈락(RED)", errFail.persistable.length === 1 && errFail.persistable[0] === "g1:frames-stale=20", errFail.persistable);
    const throwFail = await saveStatesAndSelectPersistable({ ...base, setState: async (g) => { if (g === "g1") throw new Error("redis down"); return "OK"; } });
    check("S11 SET throw(g1) 주입: g1 탈락·예외 삼킴(RED)", throwFail.persistable.length === 1 && throwFail.persistable[0] === "g2:frames-stale=40", throwFail.persistable);
    // lock-lost / 비소유: 마커 전마커 탈락 + 비소유는 SET 자체를 시도하지 않는다(stale writer 보호).
    let setCalls = 0;
    const lockLostRes = await saveStatesAndSelectPersistable({ ...base, lockLost: true, setState: async () => { setCalls += 1; return "OK"; } });
    check("S11 lock-lost 주입: 전마커 탈락 + SET 무호출(RED)", lockLostRes.persistable.length === 0 && setCalls === 0, { persistable: lockLostRes.persistable, setCalls });
    const notOwnerRes = await saveStatesAndSelectPersistable({ ...base, stillOwner: false, setState: async () => { setCalls += 1; return "OK"; } });
    check("S11 비소유 주입: 전마커 탈락 + SET 무호출(RED)", notOwnerRes.persistable.length === 0 && setCalls === 0, { persistable: notOwnerRes.persistable, setCalls });
    // 순수 selector 단독 축(기형 마커 방어) — seam 내부에서 재사용되는 함수의 경계 검증.
    check("S11 기형 마커(gameId 없음): 탈락", selectPersistableStaleMarkers({ markers: ["frames-stale=20"], lockLost: false, stillOwner: true, stateSetOk: () => true }).length === 0, "malformed");
    // route 배선 구조 판정: route 는 seam 을 호출할 뿐 `=== "OK"` 판정을 본문에 복제하지 않는다.
    const rawRoute = readFileSync(
      new URL("../../src/app/api/cron/relay-live-publisher/route.ts", import.meta.url),
      "utf8",
    );
    const routeSrc = rawRoute
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
      .replace(/^[ \t]*\/\/[^\n]*/gm, (m) => " ".repeat(m.length));
    const seamWired = /await saveStatesAndSelectPersistable\(\{/.test(routeSrc) && /setState: \(gameId, serialized\) =>/.test(routeSrc);
    check("S11 route: seam 호출 배선(setState 주입)", seamWired, seamWired);
    // state SET 결과 판정(setResult === "OK")이 route 본문에 복제되면 seam 을 우회한
    // mutation 이 관측 불가가 된다. (acquireLock 의 lock SET "OK" 판정은 별개 계약이라 제외.)
    const okJudgeInRoute = /setResult === "OK"|stateSetOk\.set\(/.test(routeSrc);
    check("S11 route: state-SET 판정 본문 복제 없음(seam 단일화)", !okJudgeInRoute, okJudgeInRoute);
  }

  console.log(`\nRESULT ${fail === 0 ? "PASS" : "FAIL"} — ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });
