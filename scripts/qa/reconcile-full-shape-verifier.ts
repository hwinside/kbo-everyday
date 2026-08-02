/**
 * 원장 incomplete 경기 full-shape reconcile dry-run 검증기 (읽기 전용).
 *
 * 왜 필요한가 — 삼순 P0:
 *   축소 fixture(경기당 stale 1건)는 실제 경계를 놓친다. 운영에는 한 경기에
 *   stale/added 쌍이 **여러 개** 동시에 있는 경우가 있고, 그러면 승인표에 있는
 *   한 줄이 통과해도 나머지 쌍이 `ambiguous_rekey_counterpart` 로 전체 atomic
 *   reconcile 을 거부시킨다. 즉 "그 경기는 치유된다"는 주장이 성립하지 않는다.
 *
 * 그래서 이 스크립트는:
 *   1. 원장에서 status='incomplete' 경기를 전부 읽고
 *   2. 각 경기의 **실제 KBO boxscore** 와 **현재 DB player_game_logs 행**을 그대로 가져와
 *   3. production helper(buildGameIngestion + planStaleReconciliation)에 전수 재입력해
 *   4. refusal 사유별 분포와 경기별 판정을 출력한다.
 *
 * DB 를 **변경하지 않는다** (select 만). 백필 실행 전/후 근거로 쓴다.
 *
 * usage:
 *   npx tsx scripts/qa/reconcile-full-shape-verifier.ts            # 분포 출력
 *   npx tsx scripts/qa/reconcile-full-shape-verifier.ts --expect   # 기대 계약 assert (release verifier)
 *   npx tsx scripts/qa/reconcile-full-shape-verifier.ts --game <id>
 *
 * env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 */
import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { getSeasonGames } from "@/lib/crawler/season-games-cache";
import { fetchGameBoxscore } from "@/lib/game-logs/ingest";
import { CANONICAL_ROW_FIELDS, buildGameIngestion, type CanonicalRowInput } from "@/lib/game-logs/completeness";
import { planStaleReconciliation, type ReconcileRefusalReason } from "@/lib/game-logs/reconcile";
import {
  assertDeletionKeysMatchStaleKeys,
  assertExpectedApprovedHeals,
} from "./reconcile-full-shape-assertions";

const EXPECT = process.argv.includes("--expect");
const gameArg = process.argv.indexOf("--game");
const ONLY_GAME = gameArg >= 0 ? process.argv[gameArg + 1] : null;
const SEASON = 2026;
const REGULAR_SEASON_SR_ID = "0";

type Verdict = ReconcileRefusalReason | "healable" | "no_regular_game" | "boxscore_unavailable" | "missing_required_field";

interface GameVerdict {
  gameId: string;
  verdict: Verdict;
  staleKeys: string[];
  deletions: string[];
  detail?: string;
}

/**
 * 시즌 우주 sanity 하한(2026 실측 491 final).
 *
 * ⚠️ 이건 대뷄 방법일 뿐 충분 조건이 아니다 — 450을 넘어도 최대 41경기가 빠질 수 있고,
 * 그러면 빠진 경기가 no_regular_game 으로 조용히 오분류된다(삼순 지적).
 * 진짜 게이트는 아래 assertAllTargetsResolvable — **대상 game_id 가 전부** 우주에 있고
 * boxscore 조회까지 성공해야 한다. 이 상수는 "명백히 망가진 우주"를 조기에 자르는 용도다.
 */
const MIN_SEASON_FINALS = 450;

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 필요");
  const client = createClient(url, key, { auth: { persistSession: false } });

  // query-guard: bounded -- 원장 incomplete 행만(현재 수십 건), 진단 전용 읽기
  const { data: ledger, error } = await client
    .from("player_game_log_ingestions")
    .select("game_id,status,failure_reason")
    .eq("status", "incomplete");
  if (error) throw new Error(`ledger 조회 실패: ${error.message}`);

  let targets = (ledger ?? []).map((r) => String(r.game_id)).sort();
  if (ONLY_GAME) targets = targets.filter((g) => g === ONLY_GAME);
  console.log(`[full-shape] incomplete 원장 ${targets.length}경기 전수 재입력 (DB 무변경)\n`);

  // ⚠️ getSeasonGames 는 fail-soft 월별 캐시라 일시적 상류 장애에서 조용히 partial 을 돌려준다.
  // 그러면 멀짱한 경기가 `no_regular_game` 으로 오분류되어 판정 분포가 흔들린다
  // (실제로 이 검증기 초반에 run 마다 no_regular_game/boxscore_unavailable 이 오가는 걸 봤다).
  // 우주가 빈약하면 판정하지 말고 **바로 중단**한다 — 느슨한 우주로 난 분포는 근거가 아니다.
  const seasonGames = await getSeasonGames(SEASON, REGULAR_SEASON_SR_ID);
  const finals = seasonGames.filter((g) => g.status === "final");
  if (finals.length < MIN_SEASON_FINALS) {
    throw new Error(
      `시즌 우주가 불완전함(final ${finals.length} < ${MIN_SEASON_FINALS}) — ` +
      `partial 우주로 판정하면 멀짱한 경기가 no_regular_game 으로 오분류된다. 재시도 필요.`,
    );
  }
  const byId = new Map(seasonGames.map((g) => [g.gameId, g]));
  console.log(`[full-shape] 시즌 우주 final ${finals.length}경기 확보\n`);

  const verdicts: GameVerdict[] = [];
  const unresolvable: string[] = [];
  for (const gameId of targets) {
    const game = byId.get(gameId);
    if (!game) {
      unresolvable.push(`${gameId}: 우주에 없음(no_regular_game)`);
      verdicts.push({ gameId, verdict: "no_regular_game", staleKeys: [], deletions: [] });
      continue;
    }
    const box = await fetchGameBoxscore(gameId);
    if (!box) {
      unresolvable.push(`${gameId}: boxscore 조회 실패`);
      verdicts.push({ gameId, verdict: "boxscore_unavailable", staleKeys: [], deletions: [] });
      continue;
    }
    const build = buildGameIngestion(game, box);
    if (build.missingFields.length > 0) {
      unresolvable.push(`${gameId}: 필수 필드 누락(missing_required_field)`);
      verdicts.push({
        gameId, verdict: "missing_required_field", staleKeys: [], deletions: [],
        detail: `${build.missingFields.length}필드`,
      });
      continue;
    }

    // query-guard: bounded -- game_id 단위 선수 행, 경기당 최대 ~60행
    const { data: rows, error: rowErr } = await client
      .from("player_game_logs")
      .select(CANONICAL_ROW_FIELDS.join(","))
      .eq("game_id", gameId);
    if (rowErr) throw new Error(`player_game_logs 조회 실패 (${gameId}): ${rowErr.message}`);
    const beforeRows = (rows ?? []) as unknown as CanonicalRowInput[];

    // production helper 그대로 — 알고리즘 복제 금지
    const plan = planStaleReconciliation(beforeRows, beforeRows, build.rows, build.unresolved.length);

    const expectedKeys = new Set(build.rows.map((r) => `${r.kbo_id}\u0000${r.player_type}`));
    const stale = beforeRows.filter((r) => !expectedKeys.has(`${r.kbo_id}\u0000${r.player_type}`));

    verdicts.push({
      gameId,
      verdict: plan.refusal ?? "healable",
      staleKeys: stale.map((r) => `${r.kbo_id}|${r.player_type}`),
      deletions: plan.deletions.map((r) => `${r.kbo_id}|${r.player_type}`),
      detail: stale.map((r) => `${r.kbo_id}|${r.player_type}`).join(","),
    });
  }

  const dist = new Map<Verdict, number>();
  for (const v of verdicts) dist.set(v.verdict, (dist.get(v.verdict) ?? 0) + 1);

  console.log("판정 분포:");
  for (const [k, n] of [...dist.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(30)} ${n}`);
  }

  const healable = verdicts.filter((v) => v.verdict === "healable");
  console.log(`\n치유 가능(healable) ${healable.length}경기:`);
  for (const v of healable) {
    console.log(`  ✓ ${v.gameId}  삭제 ${v.deletions.join(",") || "(0)"}`);
  }

  const lg = verdicts.filter((v) => v.gameId.includes("LG"));
  if (lg.length > 0) {
    console.log(`\nLG 관련 ${lg.length}경기 (시즌 baseline 직결):`);
    for (const v of lg) {
      console.log(`  ${v.verdict === "healable" ? "✓" : "✗"} ${v.gameId}  ${v.verdict}  stale=[${v.detail ?? ""}]`);
    }
  }

  const blocked = verdicts.filter((v) => v.verdict !== "healable");
  console.log(`\n잔여 미치유 ${blocked.length}경기:`);
  for (const v of blocked) {
    console.log(`  ✗ ${v.gameId}  ${v.verdict}  stale=[${v.detail ?? ""}]`);
  }

  if (EXPECT) {
    console.log("\n[release verifier] 계약 검증");
    // ① pre-backfill gate — 대상 game_id 가 **전부** 우주에 존재하고 boxscore 조회까지 성공해야 한다.
    //   final>=450 상수만으로는 최대 41경기 누락을 통과시킨다(삼순 지적).
    //   누락된 경기는 no_regular_game/boxscore_unavailable 로 조용히 오분류되어
    //   "재식별 문제가 없다"는 거짓 근거가 된다. 하나라도 미해결이면 중단한다.
    //   (단, 정규 우주 밖 경기 — 예: 올스타전 20260711WEEA0 — 는 예외로 명시 허용.)
    const EXEMPT_NON_REGULAR = new Set(["20260711WEEA0"]);
    const blockingUnresolvable = unresolvable.filter(
      (line) => !EXEMPT_NON_REGULAR.has(line.split(":")[0]),
    );
    assert.deepEqual(
      blockingUnresolvable,
      [],
      `대상 경기 중 우주 미해결/조회실패가 있다 — 이 상태의 분포는 근거가 아니다:\n${blockingUnresolvable.join("\n")}`,
    );
    console.log(`  · 대상 ${targets.length}경기 전부 우주 해결 + boxscore 조회 성공(정규 밖 예외 ${EXEMPT_NON_REGULAR.size})`);
    // ① 거부된 경기는 부분 삭제가 0 이어야 한다(atomic) — 이 PR 의 핵심 안전 계약.
    for (const v of verdicts) {
      if (v.verdict !== "healable") {
        assert.deepEqual(v.deletions, [], `${v.gameId}: 거부인데 삭제가 계획됨`);
      }
    }
    // ② 삭제 key 집합은 stale key 집합과 경기별 exact-set으로 같아야 한다.
    //    개수만 같고 key가 다른 회귀도 즉시 실패한다.
    for (const v of healable) {
      assertDeletionKeysMatchStaleKeys(v.gameId, v.deletions, v.staleKeys);
    }
    // ③ 승인된 운영 shape 4경기와 삭제 exact-set 전체를 고정한다.
    const healedWithStale = healable.filter((v) => v.staleKeys.length > 0);
    assertExpectedApprovedHeals(Object.fromEntries(healedWithStale.map((v) => [v.gameId, v.deletions])));
    console.log(`  · stale 치유 ${healedWithStale.length}경기 / stale 없는 healable ${healable.length - healedWithStale.length}경기`);
    // ③ LG 잔여를 숨기지 않는다 — 화면 blocker 해소 주장의 근거로 쓰지 못하게 명시적으로 실패시킨다.
    const lgBlocked = lg.filter((v) => v.verdict !== "healable");
    console.log(
      `  · LG 관련 ${lg.length}경기 중 치유 ${lg.length - lgBlocked.length} / 잔여 ${lgBlocked.length}`,
    );
    console.log("  ✓ 승인표 밖 삭제 0 · 거부 경기 삭제 0 · 치유 경기 존재");
  }

  console.log(`\n(읽기 전용 — DB 변경 없음)`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error(e);
  process.exit(1);
});
