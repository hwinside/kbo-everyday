/**
 * 도루·출루율·장타율·OPS 를 **앱과 같은 숫자**로 답하는가 — 소스 정합 게이트.
 *
 * ⚠️ 이 게이트가 생긴 이유 (하린아빠 2026-08-04 20:42).
 *   "도루 OPS가 왜 없어?" / "우리가 다 제공하고 있는 데이터인데"
 *
 * 나는 `player_stats_batter` 테이블만 보고 "sb·ops 컬럼이 없으니 답할 수 없다"고 보고했다.
 * 틀렸다. 앱은 이미 이 값을 화면에 보여주고 있었다 — 선수 상세(`도루`·`OPS`), 팀 기록,
 * 타이틀 탭이 전부 `/api/stats` 를 쓰고, 그 정본이 `stats-2026-batters.json` 이다.
 * (Production 실측: `source=naver-fallback`, 황성빈 35도루·김도영 OPS 1.022 — JSON 값과 일치.)
 *
 * 그래서 지표를 열되, **소스가 둘로 갈라진다**는 새 리스크가 생긴다:
 *   · 겹치는 지표(games·hr·rbi…)는 DB 와 스냅샷 양쪽에 있다
 *   · 한쪽만 갱신된 순간 봇이 앱과 **다른 숫자**를 말한다 — 그게 최악이다
 * 따라서 스냅샷으로 답할 때는 DB row 와 교차검증하고, 어긋나면 답하지 않는다.
 *
 * 실행: npm run qa:genius-snapshot-metrics
 */
import assert from "node:assert/strict";
import batterSnapshot from "../../src/lib/constants/stats-2026-batters.json";
import {
  BATTER_METRICS,
  isSnapshotOnlyMetric,
  resolveSeasonRecordIntent,
  resolveSeasonRecord,
  SNAPSHOT_ONLY_BATTER_METRICS,
  type SeasonRecordRow,
} from "../../src/lib/baseball-qa/stats/season-record";
import {
  crossCheckSnapshotAgainstDb,
  createSnapshotRecordFetcher,
  fetchSnapshotBatterRows,
  SNAPSHOT_GENERATED_AT,
} from "../../src/lib/baseball-qa/stats/snapshot-record";

let pass = 0;
const failures: string[] = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (error) {
    failures.push(`${name}: ${(error as Error).message}`);
    console.error(`  ❌ ${name}: ${(error as Error).message}`);
  }
}

interface SnapRow { name: string; team: string; kboId: string; [k: string]: unknown }
const ROWS = batterSnapshot as unknown as SnapRow[];

async function main() {
  // ── ① 스냅샷 소스가 실제로 그 값을 갖고 있다 ────────────────────────────
  await check("스냅샷에 선수가 있다", () => {
    assert.ok(ROWS.length > 100, `타자 스냅샷이 비어 있다 (len=${ROWS.length})`);
  });
  await check("스냅샷이 sb·cs·obp·slg·ops 를 전부 갖는다", () => {
    const cols = new Set(Object.keys(ROWS[0]));
    for (const metric of SNAPSHOT_ONLY_BATTER_METRICS) {
      assert.ok(cols.has(metric), `스냅샷에 '${metric}' 컬럼이 없다 — 이 지표는 답할 수 없다`);
    }
  });
  await check("실제 값이 들어 있다(전부 0/빈값이 아니다)", () => {
    const withSb = ROWS.filter((r) => Number(r.sb) > 0).length;
    const withOps = ROWS.filter((r) => String(r.ops ?? "") !== "" && String(r.ops) !== ".000").length;
    assert.ok(withSb > 10, `도루>0 선수가 ${withSb}명뿐 — 수집이 죽었다`);
    assert.ok(withOps > 100, `OPS 보유 선수가 ${withOps}명뿐 — 수집이 죽었다`);
  });

  // ── ② 질문 → 지표 매칭 ─────────────────────────────────────────────────
  const intentOf = (q: string) => {
    const i = resolveSeasonRecordIntent(q);
    return i.kind === "query" ? `${i.query.table}/${i.query.metric}` : i.kind;
  };
  for (const [question, expected] of [
    ["박해민 도루 몇 개야?", "batter/sb"],
    ["김도영 도루 알려줘", "batter/sb"],
    ["김도영 출루율 얼마야", "batter/obp"],
    ["구자욱 장타율 알려줘", "batter/slg"],
    ["문보경 OPS 알려줘", "batter/ops"],
  ] as const) {
    await check(`매칭 "${question}" → ${expected}`, () => {
      assert.equal(intentOf(question), expected);
    });
  }

  // ⚠️ `도루 실패`는 도루(sb)가 아니라 도루자(cs)다. `도루` 패턴이 먼저 매칭되면 오답이 된다.
  // 그리고 `실패 몇 개`가 투수 **패전**(`패 몇 개`)으로 새던 회귀도 여기서 잡는다(실측).
  for (const question of ["황성빈 도루 실패 몇 개야?", "박해민 도루자 몇 개야?"]) {
    await check(`경계 "${question}" → batter/cs`, () => {
      assert.equal(intentOf(question), "batter/cs");
    });
  }
  await check("투수 패전은 회귀 없음", () => {
    assert.equal(intentOf("류현진 몇 패"), "pitcher/losses");
    assert.equal(intentOf("김광현 패 몇 개"), "pitcher/losses");
  });
  await check("장타율이 타율로 새지 않는다", () => {
    assert.equal(intentOf("문보경 장타율 알려줘"), "batter/slg");
    assert.equal(intentOf("문보경 타율 알려줘"), "batter/avg");
  });

  // ── ③ production seam 이 실제 값을 돌려준다 ─────────────────────────────
  // ⚠️ 자체 fixture 를 만들면 loader 가 끊겨도 GREEN 이다(삼순 8차 P0-2와 같은 함정).
  const fetcher = createSnapshotRecordFetcher();
  const subject = ROWS.find((r) => Number(r.sb) > 0)!;
  await check("production fetcher 가 kboId exact 로 행을 찾는다", async () => {
    const rows = await fetcher(subject.kboId);
    assert.equal(rows.length, 1, `kboId=${subject.kboId} 행이 ${rows.length}개`);
    assert.equal(rows[0].kbo_id, subject.kboId);
    assert.equal(rows[0].player_key, subject.kboId);
    assert.equal(rows[0].name, subject.name);
  });
  await check("없는 kboId 는 빈 배열(추측 금지)", async () => {
    assert.deepEqual(await fetcher("00000000"), []);
  });
  await check("stale 판정용 기준시각이 붙는다", () => {
    assert.ok(SNAPSHOT_GENERATED_AT.length > 0, "스냅샷 생성시각이 비어 있다");
    assert.ok(Number.isFinite(Date.parse(SNAPSHOT_GENERATED_AT)), "생성시각 파싱 불가");
  });

  // ── ④ 기존 검증기를 그대로 통과한다(identity·값 형식) ────────────────────
  await check("resolveSeasonRecord 가 스냅샷 행을 그대로 검증한다", () => {
    const rows = fetchSnapshotBatterRows(subject.kboId);
    const outcome = resolveSeasonRecord(
      rows,
      { table: "batter", metric: "sb", label: "도루", kind: "count" },
      subject.kboId,
      Date.parse(SNAPSHOT_GENERATED_AT) + 1000,
      subject.name,
      subject.team,
    );
    assert.equal(outcome.kind, "ok", `outcome=${outcome.kind}`);
    assert.equal(outcome.kind === "ok" && outcome.value, String(subject.sb));
  });
  await check("다른 선수 kboId 로는 fail-close", () => {
    const rows = fetchSnapshotBatterRows(subject.kboId);
    const outcome = resolveSeasonRecord(
      rows,
      { table: "batter", metric: "sb", label: "도루", kind: "count" },
      "99999999",
      Date.now(),
    );
    assert.equal(outcome.kind, "inconsistent");
  });

  // ── ⑤ 교차검증: 두 소스가 갈라지면 답하지 않는다 ─────────────────────────
  const snapRow = fetchSnapshotBatterRows(subject.kboId)[0];
  const dbRow = (): SeasonRecordRow => ({
    player_key: subject.kboId, kbo_id: subject.kboId,
    name: subject.name, team: subject.team,
    updated_at: new Date().toISOString(),
    games: snapRow.games, ab: snapRow.ab, hits: snapRow.hits,
    hr: snapRow.hr, rbi: snapRow.rbi, runs: snapRow.runs,
    doubles: snapRow.doubles, triples: snapRow.triples, tb: snapRow.tb,
  });
  await check("두 소스가 같으면 통과", () => {
    assert.equal(crossCheckSnapshotAgainstDb(snapRow, [dbRow()]).kind, "ok");
  });
  await check("겹치는 지표가 어긋나면 거부(앱과 다른 숫자 방지)", () => {
    const bad = { ...dbRow(), hr: Number(snapRow.hr) + 1 };
    const r = crossCheckSnapshotAgainstDb(snapRow, [bad]);
    assert.equal(r.kind, "mismatch");
    assert.equal(r.kind === "mismatch" && r.metric, "hr");
  });
  await check("DB 행이 없으면 거부(확인 못 한 상태로 답하지 않는다)", () => {
    assert.equal(crossCheckSnapshotAgainstDb(snapRow, []).kind, "no_db_row");
  });
  await check("DB 행이 2개면 거부", () => {
    assert.equal(crossCheckSnapshotAgainstDb(snapRow, [dbRow(), dbRow()]).kind, "no_db_row");
  });
  await check("identity 가 다르면 거부", () => {
    const other = { ...dbRow(), kbo_id: "77777777", player_key: "77777777" };
    assert.equal(crossCheckSnapshotAgainstDb(snapRow, [other]).kind, "mismatch");
  });

  // ── ⑥ allowlist 선언 정합 ───────────────────────────────────────────────
  await check("SNAPSHOT_ONLY 지표가 전부 BATTER_METRICS 에 선언돼 있다", () => {
    for (const metric of SNAPSHOT_ONLY_BATTER_METRICS) {
      assert.ok(metric in BATTER_METRICS, `${metric} 이 BATTER_METRICS 에 없다`);
      assert.equal(isSnapshotOnlyMetric(metric), true);
    }
  });
  await check("DB 지표는 스냅샷 전용으로 분류되지 않는다", () => {
    for (const metric of ["avg", "hr", "rbi", "games"]) {
      assert.equal(isSnapshotOnlyMetric(metric), false, `${metric} 을 스냅샷 전용으로 오분류`);
    }
  });

  if (failures.length > 0) {
    console.error(`\n❌ genius snapshot metrics: PASS=*** FAIL=${failures.length}`);
    process.exit(1);
  }
  console.log(`\n✅ genius snapshot metrics: ${pass} PASS (도루·출루율·장타율·OPS 실값 + 소스 교차검증)`);
}

main().catch((error) => {
  console.error("❌ genius snapshot metrics FAIL:", error);
  process.exit(1);
});
