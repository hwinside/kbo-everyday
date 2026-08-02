/**
 * 실책 데이터 경로 actual-wiring 회귀 — 삼순 P0/P1 (2026-08-02).
 *
 * ⚠️ 이 파일이 존재하는 이유: 직전 라운드의 태그 회귀는 D7 값을 **직접 주입**해서,
 * `fetchGameErrors()` 를 항상 `{away:0,home:0}` 반환하도록 바꿔도 전부 PASS 했다
 * (삼순 mutation 실증). 즉 데이터 경로가 통째로 false-green 이었다.
 * 여기서는 `game-errors.ts` 를 직접 import 해 실제 응답 shape 로 검증한다.
 *
 * 검증 축:
 *  ① 결손 E 를 0 으로 승격하지 않는가 (공용 파서는 `e ?? 0`/`bsSafeInt("")=0` 로 승격함)
 *  ② KBO valid → 채택 / KBO 결손·비final → Naver / 양쪽 결손 → 미확인(key 부재)
 *  ③ canonical 최종 스코어와 exact 대조해 stale·타 경기 응답 거부
 *  ④ deadline 이 실제 fetch 를 abort 하는가, 중복 gameId 제거
 */
import "./_smoke-env";

import {
  __resetGameErrorCaches,
  fetchGameErrors,
  fetchGameErrorsWithinDeadline,
  parseErrorCell,
  parseKboErrorObservation,
  parseNaverErrorObservation,
} from "../../src/lib/venue-stats/game-errors";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** KBO GetScoreBoard 실제 shape. tail 4칸 = R/H/E/BB. */
function kboPayload(opts: {
  awayR: string; awayE: string; homeR: string; homeE: string;
  endTm?: string; cancel?: string;
}) {
  const row = (r: string, e: string) => ({
    row: [
      { Text: "" }, { Text: "LG" },
      { Text: "0" }, { Text: "1" }, { Text: "0" },
      { Text: r }, { Text: "7" }, { Text: e }, { Text: "3" },
    ],
  });
  return [
    [{ END_TM: opts.endTm ?? "21:30", CANCEL_SC_NM: opts.cancel ?? "" }],
    [JSON.stringify({ rows: [row(opts.awayR, opts.awayE), row(opts.homeR, opts.homeE)] })],
  ];
}

/** Naver record 실제 shape. */
function naverPayload(rheb: { away: Record<string, unknown>; home: Record<string, unknown> }) {
  return { result: { recordData: { scoreBoard: { inn: { away: [0], home: [0] }, rheb } } } };
}

async function main() {
  console.log("실책 데이터 경로 — 결손≠0 · failover · canonical 대조");

  // ── ① 결손을 0 으로 승격하지 않는다 (삼순 P0 재현) ────────────────────────
  {
    for (const bad of ["", "  ", null, undefined, "-", "x", -1, 1.5, true]) {
      ok(`E 셀 ${JSON.stringify(bad)} → null(결손, 0 아님)`, parseErrorCell(bad) === null);
    }
    ok("E 셀 0 은 유효한 값(실책 없음)", parseErrorCell(0) === 0);
    ok("E 셀 '2' 문자열 정상 파싱", parseErrorCell("2") === 2);

    // KBO raw 에서 E 칸만 비면 관측 자체가 null 이어야 한다.
    ok(
      "KBO: E 칸 빈 문자열 → 관측 null (공용 파서는 0 으로 승격했음)",
      parseKboErrorObservation(kboPayload({ awayR: "1", awayE: "", homeR: "2", homeE: "0" })) === null,
    );
    // Naver 도 동일.
    ok(
      "Naver: rheb.e 결손 → 관측 null",
      parseNaverErrorObservation(naverPayload({
        away: { r: 1, h: 5 }, home: { r: 2, h: 4 },
      })) === null,
    );
    // 정상 케이스는 통과해야 한다(과잉 차단 아님).
    const kboOk = parseKboErrorObservation(kboPayload({ awayR: "1", awayE: "2", homeR: "2", homeE: "0" }));
    ok("KBO 정상 → away 2 / home 0", kboOk?.away === 2 && kboOk?.home === 0, JSON.stringify(kboOk));
    const naverOk = parseNaverErrorObservation(naverPayload({
      away: { r: 1, h: 5, e: 2 }, home: { r: 2, h: 4, e: 0 },
    }));
    ok("Naver 정상 → away 2 / home 0", naverOk?.away === 2 && naverOk?.home === 0, JSON.stringify(naverOk));
  }

  // ── ② 종료 경기만 채택 ─────────────────────────────────────────────────
  {
    ok(
      "KBO: END_TM 없음(진행 중) → 관측 null",
      parseKboErrorObservation(kboPayload({ awayR: "1", awayE: "1", homeR: "0", homeE: "0", endTm: "" })) === null,
    );
    ok(
      "KBO: 취소 경기 → 관측 null",
      parseKboErrorObservation(kboPayload({ awayR: "0", awayE: "0", homeR: "0", homeE: "0", cancel: "우천취소" })) === null,
    );
  }

  // ── ③ failover — KBO valid / KBO 결손→Naver / 양쪽 결손→미확인 ───────────
  {
    let naverCalls = 0;
    const fromKbo = await fetchGameErrors("20260801LGOB0", {
      fetchers: {
        kbo: async () => kboPayload({ awayR: "2", awayE: "1", homeR: "2", homeE: "0" }),
        naver: async () => { naverCalls += 1; return null; },
      },
    });
    ok("KBO 유효 → 채택", fromKbo?.away === 1 && fromKbo?.home === 0, JSON.stringify(fromKbo));
    ok("KBO 유효면 Naver 호출 안 함", naverCalls === 0);

    const fellBack = await fetchGameErrors("20260801LGOB0", {
      fetchers: {
        kbo: async () => kboPayload({ awayR: "2", awayE: "", homeR: "2", homeE: "" }),
        naver: async () => naverPayload({ away: { r: 2, h: 7, e: 3 }, home: { r: 2, h: 7, e: 1 } }),
      },
    });
    ok("KBO 결손 → Naver failover", fellBack?.away === 3 && fellBack?.home === 1, JSON.stringify(fellBack));

    const kboThrows = await fetchGameErrors("20260801LGOB0", {
      fetchers: {
        kbo: async () => { throw new Error("KBO 503"); },
        naver: async () => naverPayload({ away: { r: 2, h: 7, e: 0 }, home: { r: 2, h: 7, e: 2 } }),
      },
    });
    ok("KBO 예외 → Naver failover", kboThrows?.away === 0 && kboThrows?.home === 2, JSON.stringify(kboThrows));

    const bothMissing = await fetchGameErrors("20260801LGOB0", {
      fetchers: {
        kbo: async () => kboPayload({ awayR: "2", awayE: "", homeR: "2", homeE: "" }),
        naver: async () => naverPayload({ away: { r: 2, h: 7 }, home: { r: 2, h: 7 } }),
      },
    });
    ok("양쪽 결손 → 미확인(null). 0 으로 채우지 않음", bothMissing === null, JSON.stringify(bothMissing));

    const bothThrow = await fetchGameErrors("20260801LGOB0", {
      fetchers: {
        kbo: async () => { throw new Error("x"); },
        naver: async () => { throw new Error("y"); },
      },
    });
    ok("양쪽 예외 → 미확인(null)", bothThrow === null);
  }

  // ── ④ canonical 최종 스코어 exact 대조 (stale/타 경기 거부) ──────────────
  {
    const canonical = { awayScore: 2, homeScore: 5 };
    const mismatchedKbo = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        // KBO 가 다른 스코어(=stale/다른 경기) → 거부하고 Naver 로
        kbo: async () => kboPayload({ awayR: "1", awayE: "9", homeR: "1", homeE: "9" }),
        naver: async () => naverPayload({ away: { r: 2, h: 7, e: 1 }, home: { r: 5, h: 9, e: 0 } }),
      },
    });
    ok(
      "KBO 스코어 불일치 → 거부하고 Naver 채택",
      mismatchedKbo?.away === 1 && mismatchedKbo?.home === 0,
      JSON.stringify(mismatchedKbo),
    );

    const bothMismatch = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        kbo: async () => kboPayload({ awayR: "1", awayE: "9", homeR: "1", homeE: "9" }),
        naver: async () => naverPayload({ away: { r: 9, h: 7, e: 1 }, home: { r: 9, h: 9, e: 0 } }),
      },
    });
    ok("양쪽 스코어 불일치 → 미확인(null)", bothMismatch === null, JSON.stringify(bothMismatch));

    // canonical 없으면 대조를 건너뛴다(비final 경기 등).
    const noCanonical = await fetchGameErrors("20260801LGOB0", {
      canonical: null,
      fetchers: { kbo: async () => kboPayload({ awayR: "1", awayE: "3", homeR: "1", homeE: "0" }) },
    });
    ok("canonical 미제공 시 대조 생략", noCanonical?.away === 3);
  }

  // ── ⑤ 배치 — 미확인 경기는 Map 에 키 자체가 없다 ─────────────────────────
  {
    const batch = await fetchGameErrorsWithinDeadline(
      [
        { gameId: "A", canonical: { awayScore: 1, homeScore: 2 } },
        { gameId: "B", canonical: { awayScore: 1, homeScore: 2 } },
        { gameId: "A", canonical: { awayScore: 1, homeScore: 2 } }, // 중복
      ],
      {
        fetchers: {
          kbo: async (id) =>
            id === "A"
              ? kboPayload({ awayR: "1", awayE: "2", homeR: "2", homeE: "1" })
              : kboPayload({ awayR: "1", awayE: "", homeR: "2", homeE: "" }),
          naver: async () => null,
        },
      },
    );
    ok("확인된 경기만 Map 에 존재", batch.size === 1 && batch.has("A"), JSON.stringify([...batch]));
    ok("미확인 경기는 키 부재(0 아님)", !batch.has("B"));
    ok("중복 gameId 는 1회만 처리", batch.get("A")?.away === 2);
  }

  // ── ⑥ deadline 이 실제 fetch 를 abort 하는가 (삼순 P1) ───────────────────
  // 주입 fetcher 에도 signal 을 전달해, 바깥 Promise 만 푸는 게 아니라 **네트워크 작업이
  // 실제로 취소되는지**를 관측한다. 예전 구현은 setTimeout 으로 resolve 만 해서
  // "bounded" 가 이름뿐이었다.
  {
    let abortObserved = false;
    const slow = (_id: string, signal?: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(null), 5_000);
        if (signal) {
          if (signal.aborted) {
            clearTimeout(t);
            abortObserved = true;
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => {
            clearTimeout(t);
            abortObserved = true;
            reject(new Error("aborted"));
          });
        }
      });

    const started = Date.now();
    const res = await fetchGameErrorsWithinDeadline([{ gameId: "SLOW" }], {
      deadlineMs: 150,
      fetchers: { kbo: slow, naver: slow },
    });
    const elapsed = Date.now() - started;
    ok("deadline 안에 종료(bounded)", elapsed < 2_000, `${elapsed}ms`);
    ok("deadline 초과 경기는 미확인(키 부재)", res.size === 0);
    ok("실제 fetch 가 abort 됨(바깥 Promise 만 푸는 게 아님)", abortObserved);
  }

  // ── ⑦ complete-only cache + single-flight (삼순 P1 2026-08-02) ──────────
  // 종료 경기 실책은 불변 사실이라 재조회할 이유가 없다. 그런데 GET 마다 전 직관 경기를
  // 다시 조회하고 있었다(삼순 실측: 동일 경기 2회 호출 시 KBO fetch 2회).
  // ⚠️ 성공만 캐시한다 — 미확인을 캐시하면 소스가 정상화돼도 영원히 "모름"으로 굳는다.
  {
    const canonical = { awayScore: 2, homeScore: 3 };

    __resetGameErrorCaches();
    let hits = 0;
    const okFetchers = {
      kbo: async () => { hits += 1; return kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" }); },
      naver: async () => null,
    };
    const first = await fetchGameErrorsWithinDeadline([{ gameId: "G1", canonical }], { fetchers: okFetchers });
    const second = await fetchGameErrorsWithinDeadline([{ gameId: "G1", canonical }], { fetchers: okFetchers });
    ok("동일 경기 2회 조회 시 소스 fetch 1회(complete-only cache)", hits === 1, `hits=${hits}`);
    ok(
      "캐시 결과가 최초 결과와 동일",
      JSON.stringify(first.get("G1")) === JSON.stringify(second.get("G1")),
      `${JSON.stringify(first.get("G1"))} vs ${JSON.stringify(second.get("G1"))}`,
    );

    // 미확인은 캐시하지 않는다 → 소스 정상화 시 복구되어야 한다.
    __resetGameErrorCaches();
    let broken = true;
    let recoverCalls = 0;
    const recovering = {
      kbo: async () => {
        recoverCalls += 1;
        return broken
          ? kboPayload({ awayR: "2", awayE: "", homeR: "3", homeE: "" })
          : kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" });
      },
      naver: async () => null,
    };
    const unknown = await fetchGameErrorsWithinDeadline([{ gameId: "G2", canonical }], { fetchers: recovering });
    ok("미확인 경기는 Map 에 없음", unknown.size === 0);
    broken = false;
    const recovered = await fetchGameErrorsWithinDeadline([{ gameId: "G2", canonical }], { fetchers: recovering });
    ok("미확인은 캐시하지 않아 소스 정상화 시 복구", recovered.get("G2")?.away === 1, JSON.stringify(recovered.get("G2")));
    ok("복구를 위해 소스를 다시 호출함", recoverCalls === 2, `calls=${recoverCalls}`);

    // canonical 이 다르면(스코어 정정 등) 다른 키 → 재조회.
    __resetGameErrorCaches();
    let keyCalls = 0;
    const keyFetchers = {
      kbo: async () => { keyCalls += 1; return kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" }); },
      naver: async () => null,
    };
    await fetchGameErrorsWithinDeadline([{ gameId: "G3", canonical }], { fetchers: keyFetchers });
    await fetchGameErrorsWithinDeadline(
      [{ gameId: "G3", canonical: { awayScore: 5, homeScore: 1 } }],
      { fetchers: keyFetchers },
    );
    ok("canonical 스코어가 바뀌면 캐시를 재사용하지 않음", keyCalls === 2, `calls=${keyCalls}`);

    // single-flight — 동시 요청은 소스를 한 번만 친다.
    __resetGameErrorCaches();
    let concurrentCalls = 0;
    const slowOk = {
      kbo: async () => {
        concurrentCalls += 1;
        await new Promise((r) => setTimeout(r, 40));
        return kboPayload({ awayR: "2", awayE: "2", homeR: "3", homeE: "1" });
      },
      naver: async () => null,
    };
    const [c1, c2] = await Promise.all([
      fetchGameErrorsWithinDeadline([{ gameId: "G4", canonical }], { fetchers: slowOk }),
      fetchGameErrorsWithinDeadline([{ gameId: "G4", canonical }], { fetchers: slowOk }),
    ]);
    ok("동시 요청은 single-flight 로 1회만 조회", concurrentCalls === 1, `calls=${concurrentCalls}`);
    ok("동시 요청 양쪽 모두 결과 수신", c1.get("G4")?.away === 2 && c2.get("G4")?.away === 2);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
