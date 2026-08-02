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
 *  ③ canonical 경기 ID·팀·최종 스코어와 exact 대조해 stale·타 경기 응답 거부
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
  gameId?: string; gameDate?: string; awayCode?: string; homeCode?: string;
  endTm?: string; cancel?: string; cancelId?: string;
}) {
  const row = (r: string, e: string) => ({
    row: [
      { Text: "" }, { Text: "LG" },
      { Text: "0" }, { Text: "1" }, { Text: "0" },
      { Text: r }, { Text: "7" }, { Text: e }, { Text: "3" },
    ],
  });
  return [
    [{
      G_ID: opts.gameId ?? "20260801LGOB0",
      G_DT: opts.gameDate ?? "2026-08-01",
      AWAY_ID: opts.awayCode ?? "LG",
      HOME_ID: opts.homeCode ?? "OB",
      END_TM: opts.endTm ?? "21:30",
      CANCEL_SC_NM: opts.cancel ?? "",
      CANCEL_SC_ID: opts.cancelId ?? "",
    }],
    [JSON.stringify({ rows: [row(opts.awayR, opts.awayE), row(opts.homeR, opts.homeE)] })],
  ];
}

/** Naver record 실제 shape. */
function naverPayload(
  rheb: { away: Record<string, unknown>; home: Record<string, unknown> },
  gameInfo: Record<string, unknown> = {},
) {
  return {
    result: {
      recordData: {
        gameInfo: {
          gdate: 20260801,
          gtime: "18:30",
          round: 11,
          aCode: "LG",
          hCode: "OB",
          statusCode: "4",
          cancelFlag: "N",
          ...gameInfo,
        },
        scoreBoard: { inn: { away: [0], home: [0] }, rheb },
      },
    },
  };
}

function canonicalGame(
  gameId = "20260801LGOB0",
  opts: Partial<{
    awayTeamId: number;
    homeTeamId: number;
    awayScore: number;
    homeScore: number;
  }> = {},
) {
  return {
    gameId,
    awayTeamId: opts.awayTeamId ?? 1,
    homeTeamId: opts.homeTeamId ?? 2,
    awayScore: opts.awayScore ?? 2,
    homeScore: opts.homeScore ?? 3,
  };
}

function naverScheduleWitness(canonical: ReturnType<typeof canonicalGame>) {
  return [{
    gameId: canonical.gameId,
    date: canonical.gameId.slice(0, 8),
    time: "18:30",
    stadium: "잠실",
    awayTeamId: canonical.awayTeamId,
    homeTeamId: canonical.homeTeamId,
    awayName: "LG",
    homeName: "두산",
    awayScore: canonical.awayScore,
    homeScore: canonical.homeScore,
    inning: 9,
    isTop: false,
    status: "final" as const,
    awayStarterName: "",
    homeStarterName: "",
    winPitcher: "",
    losePitcher: "",
    savePitcher: "",
    strikes: 0,
    balls: 0,
    outs: 0,
    runnersOn: { first: false, second: false, third: false },
    currentPitcher: "",
    currentBatter: "",
    awayRank: 0,
    homeRank: 0,
  }];
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
    ok(
      "Naver: gtime 결손 → 관측 null",
      parseNaverErrorObservation(naverPayload(
        { away: { r: 1, h: 5, e: 1 }, home: { r: 2, h: 4, e: 0 } },
        { gtime: "" },
      )) === null,
    );
    // `round` 는 시즌 라운드이지 DH 회차가 아니므로 identity 계약이 아니다(삼순 P1).
    // 결손해도 관측 자체를 버리지 않고 null 로만 보존한다.
    {
      const roundless = parseNaverErrorObservation(naverPayload(
        { away: { r: 1, h: 5, e: 1 }, home: { r: 2, h: 4, e: 0 } },
        { round: undefined },
      ));
      ok(
        "Naver: round 결손은 관측을 버리지 않고 gameRound=null 로 보존",
        roundless?.away === 1 && roundless.home === 0 && roundless.gameRound === null,
        JSON.stringify(roundless),
      );
    }
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
    ok(
      "KBO: 취소 코드 → 관측 null",
      parseKboErrorObservation(kboPayload({ awayR: "0", awayE: "0", homeR: "0", homeE: "0", cancelId: "1" })) === null,
    );
    ok(
      "Naver: 비final(statusCode!=4) → 관측 null",
      parseNaverErrorObservation(naverPayload(
        { away: { r: 1, h: 5, e: 1 }, home: { r: 0, h: 4, e: 0 } },
        { statusCode: "3" },
      )) === null,
    );
    ok(
      "Naver: 취소(cancelFlag!=N) → 관측 null",
      parseNaverErrorObservation(naverPayload(
        { away: { r: 0, h: 0, e: 0 }, home: { r: 0, h: 0, e: 0 } },
        { cancelFlag: "Y" },
      )) === null,
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

  // ── ④ canonical identity·팀·최종 스코어 exact 대조 ───────────────────────
  {
    const canonical = canonicalGame("20260801LGOB0", { awayScore: 2, homeScore: 5 });
    const mismatchedKbo = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        // KBO 가 다른 스코어(=stale/다른 경기) → 거부하고 Naver 로
        kbo: async () => kboPayload({ awayR: "1", awayE: "9", homeR: "1", homeE: "9" }),
        naver: async () => naverPayload({ away: { r: 2, h: 7, e: 1 }, home: { r: 5, h: 9, e: 0 } }),
        naverSchedule: async () => naverScheduleWitness(canonical),
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

    const sameScoreOtherGame = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        kbo: async () => kboPayload({
          gameId: "20260801KTOB0",
          awayCode: "KT",
          awayR: "2",
          awayE: "9",
          homeR: "5",
          homeE: "8",
        }),
        naver: async () => naverPayload({
          away: { r: 2, h: 7, e: 1 },
          home: { r: 5, h: 9, e: 0 },
        }),
        naverSchedule: async () => naverScheduleWitness(canonical),
      },
    });
    ok(
      "KBO 동일 스코어 다른 경기·팀 → 거부하고 정상 Naver 채택",
      sameScoreOtherGame?.away === 1 && sameScoreOtherGame.home === 0,
      JSON.stringify(sameScoreOtherGame),
    );

    const mismatchedNaverIdentity = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        kbo: async () => null,
        naver: async () => naverPayload(
          { away: { r: 2, h: 7, e: 9 }, home: { r: 5, h: 9, e: 8 } },
          { gdate: 20260802, aCode: "KT", hCode: "OB" },
        ),
      },
    });
    ok(
      "Naver 동일 스코어 다른 날짜·팀 → 미확인(null)",
      mismatchedNaverIdentity === null,
      JSON.stringify(mismatchedNaverIdentity),
    );

    const nonFinalNaver = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        kbo: async () => null,
        naver: async () => naverPayload(
          { away: { r: 2, h: 7, e: 9 }, home: { r: 5, h: 9, e: 8 } },
          { statusCode: "3" },
        ),
      },
    });
    ok("Naver 동일 스코어 비final → 미확인(null)", nonFinalNaver === null);

    const cancelledNaver = await fetchGameErrors("20260801LGOB0", {
      canonical,
      fetchers: {
        kbo: async () => null,
        naver: async () => naverPayload(
          { away: { r: 2, h: 7, e: 9 }, home: { r: 5, h: 9, e: 8 } },
          { cancelFlag: "Y" },
        ),
      },
    });
    ok("Naver 동일 스코어 취소 → 미확인(null)", cancelledNaver === null);

    const dh1 = canonicalGame("20240623KTLG1", {
      awayTeamId: 3,
      homeTeamId: 1,
      awayScore: 2,
      homeScore: 3,
    });
    const dh1Schedule = naverScheduleWitness(dh1)[0];
    const dh2 = canonicalGame("20240623KTLG2", {
      awayTeamId: 3,
      homeTeamId: 1,
      awayScore: 2,
      homeScore: 3,
    });
    const dhSchedule = [
      { ...dh1Schedule, time: "14:00" },
      { ...dh1Schedule, gameId: dh2.gameId, time: "17:45" },
    ];
    const dh2PayloadForDh1 = await fetchGameErrors(dh1.gameId, {
      canonical: dh1,
      fetchers: {
        kbo: async () => null,
        naver: async () => naverPayload(
          { away: { r: 2, h: 7, e: 9 }, home: { r: 3, h: 9, e: 8 } },
          { gdate: 20240623, aCode: "KT", hCode: "LG", round: 12, gtime: "17:45" },
        ),
        naverSchedule: async () => dhSchedule,
      },
    });
    ok(
      "Naver 동일 날짜·팀·스코어 DH 2차전 payload → 1차전으로 오인하지 않음",
      dh2PayloadForDh1 === null,
      JSON.stringify(dh2PayloadForDh1),
    );

    // ⚠️ `round` 는 시즌 라운드이지 DH 회차가 아니다(삼순 P1 2026-08-02).
    // 2024-06-23 실측: KT–LG 만 우연히 11/12, 한화–KIA 는 7/8, 두산–삼성은 8/9.
    // 그래서 회차 추론을 쓰면 대부분의 DH fallback 이 조용히 탈락한다 — 시작시각
    // 유일성으로만 결속하고, 아래는 실제 round 값 세 쌍을 전부 positive 로 고정한다.
    const dhCases = [
      { away: "KT", home: "LG", awayTeamId: 3, homeTeamId: 1, rounds: [11, 12], e: [1, 0, 0, 1] },
      { away: "HH", home: "HT", awayTeamId: 9, homeTeamId: 6, rounds: [7, 8], e: [0, 0, 2, 0] },
      { away: "OB", home: "SS", awayTeamId: 2, homeTeamId: 8, rounds: [8, 9], e: [1, 1, 0, 0] },
    ] as const;

    for (const dhCase of dhCases) {
      const label = `${dhCase.away}–${dhCase.home} round=${dhCase.rounds.join("/")}`;
      const g1 = canonicalGame(`20240623${dhCase.away}${dhCase.home}1`, {
        awayTeamId: dhCase.awayTeamId,
        homeTeamId: dhCase.homeTeamId,
        awayScore: 2,
        homeScore: 3,
      });
      const g2 = canonicalGame(`20240623${dhCase.away}${dhCase.home}2`, {
        awayTeamId: dhCase.awayTeamId,
        homeTeamId: dhCase.homeTeamId,
        awayScore: 2,
        homeScore: 3,
      });
      const base = naverScheduleWitness(g1)[0];
      const schedule = [
        { ...base, time: "14:00" },
        { ...base, gameId: g2.gameId, time: "17:45" },
      ];
      const common = { gdate: 20240623, aCode: dhCase.away, hCode: dhCase.home };

      const first = await fetchGameErrors(g1.gameId, {
        canonical: g1,
        fetchers: {
          kbo: async () => null,
          naver: async () => naverPayload(
            { away: { r: 2, h: 7, e: dhCase.e[0] }, home: { r: 3, h: 9, e: dhCase.e[1] } },
            { ...common, gtime: "14:00", round: dhCase.rounds[0] },
          ),
          naverSchedule: async () => schedule,
        },
      });
      ok(
        `Naver DH 1차전 통과 — ${label}`,
        first?.away === dhCase.e[0] && first?.home === dhCase.e[1],
        JSON.stringify(first),
      );

      const second = await fetchGameErrors(g2.gameId, {
        canonical: g2,
        fetchers: {
          kbo: async () => null,
          naver: async () => naverPayload(
            { away: { r: 2, h: 7, e: dhCase.e[2] }, home: { r: 3, h: 9, e: dhCase.e[3] } },
            { ...common, gtime: "17:45", round: dhCase.rounds[1] },
          ),
          naverSchedule: async () => schedule,
        },
      });
      ok(
        `Naver DH 2차전 통과 — ${label}`,
        second?.away === dhCase.e[2] && second?.home === dhCase.e[3],
        JSON.stringify(second),
      );

      // negative: 2차전 raw(17:45)를 1차전 조회에 주면 시각이 달라 탈락해야 한다.
      const crossed = await fetchGameErrors(g1.gameId, {
        canonical: g1,
        fetchers: {
          kbo: async () => null,
          naver: async () => naverPayload(
            { away: { r: 2, h: 7, e: 9 }, home: { r: 3, h: 9, e: 8 } },
            { ...common, gtime: "17:45", round: dhCase.rounds[1] },
          ),
          naverSchedule: async () => schedule,
        },
      });
      ok(`Naver DH 2차전 raw → 1차전 오인 안 함 — ${label}`, crossed === null, JSON.stringify(crossed));

      // negative: 같은 시각이 schedule 에 둘 이상이면 record 로 구분 불가 → fail-close.
      const ambiguous = await fetchGameErrors(g1.gameId, {
        canonical: g1,
        fetchers: {
          kbo: async () => null,
          naver: async () => naverPayload(
            { away: { r: 2, h: 7, e: 1 }, home: { r: 3, h: 9, e: 0 } },
            { ...common, gtime: "14:00", round: dhCase.rounds[0] },
          ),
          naverSchedule: async () => [
            { ...base, time: "14:00" },
            { ...base, gameId: g2.gameId, time: "14:00" },
          ],
        },
      });
      ok(
        `Naver 시각 모호(동시각 2경기) → fail-close — ${label}`,
        ambiguous === null,
        JSON.stringify(ambiguous),
      );
    }

    // round 결손이어도 시각이 유일하면 채택된다(round 는 identity 계약이 아니므로).
    const roundMissing = await fetchGameErrors(dh1.gameId, {
      canonical: dh1,
      fetchers: {
        kbo: async () => null,
        naver: async () => naverPayload(
          { away: { r: 2, h: 7, e: 1 }, home: { r: 3, h: 9, e: 0 } },
          { gdate: 20240623, gtime: "14:00", aCode: "KT", hCode: "LG", round: undefined },
        ),
        naverSchedule: async () => dhSchedule,
      },
    });
    ok(
      "Naver round 결손 + 시각 유일 → 채택(round 는 identity 계약 아님)",
      roundMissing?.away === 1 && roundMissing.home === 0,
      JSON.stringify(roundMissing),
    );

    // canonical 없으면 대조를 건너뛴다(비final 경기 등).
    const noCanonical = await fetchGameErrors("20260801LGOB0", {
      canonical: null,
      fetchers: { kbo: async () => kboPayload({ awayR: "1", awayE: "3", homeR: "1", homeE: "0" }) },
    });
    ok("canonical 미제공 시 대조 생략", noCanonical?.away === 3);
  }

  // ── ⑤ 배치 — 미확인 경기는 Map 에 키 자체가 없다 ─────────────────────────
  {
    const gameA = "20260801LGOB0";
    const gameB = "20260802LGOB0";
    const batch = await fetchGameErrorsWithinDeadline(
      [
        { gameId: gameA, canonical: canonicalGame(gameA, { awayScore: 1, homeScore: 2 }) },
        { gameId: gameB, canonical: canonicalGame(gameB, { awayScore: 1, homeScore: 2 }) },
        { gameId: gameA, canonical: canonicalGame(gameA, { awayScore: 1, homeScore: 2 }) }, // 중복
      ],
      {
        fetchers: {
          kbo: async (id) =>
            id === gameA
              ? kboPayload({ gameId: id, awayR: "1", awayE: "2", homeR: "2", homeE: "1" })
              : kboPayload({ gameId: id, gameDate: "2026-08-02", awayR: "1", awayE: "", homeR: "2", homeE: "" }),
          naver: async () => null,
        },
      },
    );
    ok("확인된 경기만 Map 에 존재", batch.size === 1 && batch.has(gameA), JSON.stringify([...batch]));
    ok("미확인 경기는 키 부재(0 아님)", !batch.has(gameB));
    ok("중복 gameId 는 1회만 처리", batch.get(gameA)?.away === 2);
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
    const gameId = "20260801LGOB0";
    const canonical = canonicalGame(gameId);

    __resetGameErrorCaches();
    let hits = 0;
    const okFetchers = {
      kbo: async () => { hits += 1; return kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" }); },
      naver: async () => null,
    };
    const first = await fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: okFetchers });
    const second = await fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: okFetchers });
    ok("동일 경기 2회 조회 시 소스 fetch 1회(complete-only cache)", hits === 1, `hits=${hits}`);
    ok(
      "캐시 결과가 최초 결과와 동일",
      JSON.stringify(first.get(gameId)) === JSON.stringify(second.get(gameId)),
      `${JSON.stringify(first.get(gameId))} vs ${JSON.stringify(second.get(gameId))}`,
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
    const unknown = await fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: recovering });
    ok("미확인 경기는 Map 에 없음", unknown.size === 0);
    broken = false;
    const recovered = await fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: recovering });
    ok("미확인은 캐시하지 않아 소스 정상화 시 복구", recovered.get(gameId)?.away === 1, JSON.stringify(recovered.get(gameId)));
    ok("복구를 위해 소스를 다시 호출함", recoverCalls === 2, `calls=${recoverCalls}`);

    // canonical 이 다르면(스코어 정정 등) 다른 키 → 재조회.
    __resetGameErrorCaches();
    let keyCalls = 0;
    const keyFetchers = {
      kbo: async () => { keyCalls += 1; return kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" }); },
      naver: async () => null,
    };
    await fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: keyFetchers });
    await fetchGameErrorsWithinDeadline(
      [{ gameId, canonical: canonicalGame(gameId, { awayScore: 5, homeScore: 1 }) }],
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
      fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: slowOk }),
      fetchGameErrorsWithinDeadline([{ gameId, canonical }], { fetchers: slowOk }),
    ]);
    ok("동시 요청은 single-flight 로 1회만 조회", concurrentCalls === 1, `calls=${concurrentCalls}`);
    ok("동시 요청 양쪽 모두 결과 수신", c1.get(gameId)?.away === 2 && c2.get(gameId)?.away === 2);
  }

  // ── ⑧ single-flight 가 첫 호출자 deadline 에 종속되지 않는다 (삼순 P1) ────
  // 실측 결함: A(40ms)·B(500ms)가 같은 경기를 동시에 요청하면 shared task 가
  // A 의 controller signal 로 fetch 를 걸어서, A 의 abort 가 B 까지 죽였다
  // (actual: A=null, B=null, source call=1, abort=1).
  {
    __resetGameErrorCaches();
    const gameId = "20260801LGOB0";
    const canonical = canonicalGame(gameId);
    let calls = 0;
    const slow = async (_id: string, signal?: AbortSignal) => {
      calls += 1;
      return new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" })), 100);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
      });
    };
    const [shortDeadline, longDeadline] = await Promise.all([
      fetchGameErrorsWithinDeadline([{ gameId, canonical }], {
        deadlineMs: 40, fetchers: { kbo: slow, naver: slow },
      }),
      fetchGameErrorsWithinDeadline([{ gameId, canonical }], {
        deadlineMs: 500, fetchers: { kbo: slow, naver: slow },
      }),
    ]);
    ok("짧은 deadline 호출자는 자기 예산에서 미확인", shortDeadline.size === 0, JSON.stringify([...shortDeadline]));
    ok(
      "긴 deadline 호출자는 다른 호출자의 abort 에 죽지 않음",
      longDeadline.get(gameId)?.away === 1,
      JSON.stringify([...longDeadline]),
    );
    ok("합류했으므로 소스는 1회만 호출", calls === 1, `calls=${calls}`);
  }

  // ── ⑨ 모든 대기자가 이탈하면 shared flight 도 정리된다 ────────────────────
  {
    __resetGameErrorCaches();
    const gameId = "20260801LGOB0";
    const canonical = canonicalGame(gameId);
    let aborted = false;
    const slow = async (_id: string, signal?: AbortSignal) =>
      new Promise<unknown>((resolve, reject) => {
        const t = setTimeout(() => resolve(kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" })), 3_000);
        signal?.addEventListener("abort", () => { aborted = true; clearTimeout(t); reject(new Error("aborted")); });
      });
    await fetchGameErrorsWithinDeadline([{ gameId, canonical }], {
      deadlineMs: 60, fetchers: { kbo: slow, naver: slow },
    });
    // 유일한 대기자가 떠났으므로 in-flight 네트워크 작업도 취소돼야 한다(고아 방지).
    await new Promise((r) => setTimeout(r, 30));
    ok("마지막 대기자 이탈 시 shared flight 취소", aborted);

    // 취소된 뒤에는 캐시가 없으므로 다음 요청이 다시 조회한다(영구 '모름' 금지).
    let retryCalls = 0;
    const fast = async () => { retryCalls += 1; return kboPayload({ awayR: "2", awayE: "1", homeR: "3", homeE: "0" }); };
    const retry = await fetchGameErrorsWithinDeadline([{ gameId, canonical }], {
      fetchers: { kbo: fast, naver: fast },
    });
    ok("취소 후 재요청은 정상 복구", retry.get(gameId)?.away === 1 && retryCalls === 1, `calls=${retryCalls}`);
  }

  console.log(`\n결과: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error("FAIL", error);
  process.exit(1);
});
