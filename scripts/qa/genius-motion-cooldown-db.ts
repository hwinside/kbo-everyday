/**
 * §7.4 모션 30초 1회 — **실 DB 종단** 게이트 (삼순 #1202 P0).
 *
 * 왜 DB 게이트인가: 종전 41 PASS 는 합성 시각 단위검사라 "SELECT 와 INSERT 가 별도
 * 트랜잭션이라 병렬 두 메시지가 둘 다 모션을 받는" race 를 못 잡았다. 쿨다운은 동시성
 * 계약이므로 **실제 migration SQL 을 적재한 Postgres 에서** 판정한다.
 *
 * 검사 축
 *   A 병렬 2건 → 부여 정확히 1건 (advisory lock 직렬화)
 *   B 동일 message_id 재시도 → 첫 판정 그대로 재생 (멱등)
 *   C 경계 29,999ms 억제 / 30,000ms 부여
 *   D 억제된 행은 쿨다운을 밀지 않는다 (스팸 중에도 30초마다 1회는 나온다)
 *   E 모션 없는 답변(지식·오류)은 쿨다운을 밀지 않는다
 *   F 원장 이전 payload 모션 시각도 쿨다운에 반영 (배포 직후 첫 답변 무조건 부여 방지)
 *   G 유저 격리 / 소유자 불일치·잘못된 모션 값 fail-close
 *
 * 실행: npm run qa:genius-motion-cooldown:db
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";

const MIGRATION = "20260815173000_baseball_genius_motion_cooldown_ledger.sql";
const COOLDOWN_MS = 30_000;
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const BASE = Date.parse("2026-08-15T12:00:00.000Z");

let pass = 0;
const failures: string[] = [];
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failures.push(name); console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

async function main() {
  const db = new PGlite();
  // dm_messages 는 FK 대상이라 최소 형상만 세운다(게이트 대상은 원장·RPC 계약이다).
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.dm_messages (
      id bigint primary key,
      created_at timestamptz not null default now()
    );
  `);
  const migrationSql = readFileSync(
    path.join(process.cwd(), "supabase/migrations", MIGRATION),
    "utf8",
  );
  await db.exec(migrationSql);
  check("migration 적재 (원장 + 원자 claim RPC)", true);

  let nextId = 1;
  const newMessage = async (): Promise<number> => {
    const id = nextId++;
    await db.query("insert into public.dm_messages(id) values ($1)", [id]);
    return id;
  };
  const claim = async (args: {
    messageId: number; userId?: string; motion: string | null;
    decidedAt: string; payloadLastMotionAt?: string | null;
  }) => {
    const res = await db.query<{ motion: string | null; granted: boolean }>(
      "select * from public.claim_baseball_genius_motion($1,$2,$3,$4,$5,$6)",
      [
        args.messageId, args.userId ?? USER_A, args.motion, args.decidedAt,
        COOLDOWN_MS, args.payloadLastMotionAt ?? null,
      ],
    );
    return res.rows[0];
  };

  // ── A 병렬 2건 → 부여 정확히 1건 ────────────────────────────────────────────
  {
    const m1 = await newMessage();
    const m2 = await newMessage();
    // 같은 시각에 두 요청이 동시에 도착하는 상황. 종전 구현(SELECT→INSERT 분리)이면
    // 둘 다 "직전 모션 없음"을 보고 둘 다 부여했다.
    const [r1, r2] = await Promise.all([
      claim({ messageId: m1, motion: "excited", decidedAt: at(0) }),
      claim({ messageId: m2, motion: "headspin", decidedAt: at(10) }),
    ]);
    const grantedCount = [r1, r2].filter((r) => r.granted).length;
    check("A 병렬 2건 → 부여 정확히 1건", grantedCount === 1,
      `granted=${grantedCount} (${r1.motion}/${r2.motion})`);
    const ledger = await db.query<{ n: number }>(
      "select count(*)::int as n from public.genius_motion_grants where granted",
    );
    check("A 원장에도 부여 행이 1건만 남는다", ledger.rows[0].n === 1, `rows=${ledger.rows[0].n}`);
  }

  // ── B 동일 message_id 재시도 → 첫 판정 재생 (멱등) ─────────────────────────
  {
    const m = await newMessage();
    const first = await claim({ messageId: m, motion: "bored", decidedAt: at(120_000) });
    // durable ready 재시도 — 시각이 더 흘렀어도 첫 판정을 그대로 재생해야 한다.
    const retry = await claim({ messageId: m, motion: "bored", decidedAt: at(600_000) });
    check("B 동일 id 재시도 → 같은 판정 재생(멱등)",
      first.granted && retry.granted && retry.motion === first.motion,
      `first=${first.motion}/${first.granted} retry=${retry.motion}/${retry.granted}`);
    const rows = await db.query<{ n: number }>(
      "select count(*)::int as n from public.genius_motion_grants where message_id = $1", [m],
    );
    check("B 재시도가 원장 행을 늘리지 않는다", rows.rows[0].n === 1);
    // 억제 판정도 재생되는지 (부여만 멱등하면 반쪽이다)
    const suppressed = await newMessage();
    const s1 = await claim({ messageId: suppressed, motion: "excited", decidedAt: at(121_000) });
    const s2 = await claim({ messageId: suppressed, motion: "excited", decidedAt: at(900_000) });
    check("B 억제 판정도 그대로 재생된다",
      s1.granted === false && s2.granted === false && s2.motion === null);
  }

  // ── C 경계 29,999 / 30,000 ─────────────────────────────────────────────────
  {
    const anchor = 1_000_000;
    const base = await newMessage();
    const baseRes = await claim({ messageId: base, motion: "excited", decidedAt: at(anchor) });
    check("C 기준 답변은 부여된다", baseRes.granted);
    const justUnder = await newMessage();
    const under = await claim({ messageId: justUnder, motion: "excited", decidedAt: at(anchor + COOLDOWN_MS - 1) });
    check("C 29,999ms → 억제", under.granted === false && under.motion === null);
    const exact = await newMessage();
    const on = await claim({ messageId: exact, motion: "headspin", decidedAt: at(anchor + COOLDOWN_MS) });
    check("C 정확히 30,000ms → 부여(경계 포함)", on.granted && on.motion === "headspin");
  }

  // ── D 억제된 행은 쿨다운을 밀지 않는다 ─────────────────────────────────────
  {
    const anchor = 2_000_000;
    const first = await newMessage();
    await claim({ messageId: first, motion: "excited", decidedAt: at(anchor) });
    // 스팸: 5초 간격으로 계속 두드린다 → 전부 억제되지만 쿨다운 기준은 first 그대로다.
    for (const offset of [5_000, 10_000, 15_000, 20_000, 25_000]) {
      const spam = await newMessage();
      const res = await claim({ messageId: spam, motion: "headspin", decidedAt: at(anchor + offset) });
      assert.equal(res.granted, false, `${offset}ms 에서 억제되어야 한다`);
    }
    const after = await newMessage();
    const res = await claim({ messageId: after, motion: "headspin", decidedAt: at(anchor + COOLDOWN_MS) });
    check("D 스팸 중에도 30초 뒤 1회는 부여된다(억제 행이 쿨다운을 밀지 않음)", res.granted,
      "스펙은 '30초에 1회'지 '연속이면 0회'가 아니다");
  }

  // ── E 모션 없는 답변은 쿨다운을 밀지 않는다 ────────────────────────────────
  {
    const anchor = 3_000_000;
    const knowledge = await newMessage();
    const kres = await claim({ messageId: knowledge, motion: null, decidedAt: at(anchor) });
    check("E 모션 대상 아님 → granted=false·motion=null", kres.granted === false && kres.motion === null);
    const greet = await newMessage();
    const gres = await claim({ messageId: greet, motion: "excited", decidedAt: at(anchor + 1_000) });
    check("E 직후 인사에는 모션이 부여된다(지식 답변이 쿨다운을 밀지 않음)", gres.granted);
  }

  // ── F 원장 이전 payload 모션 시각도 반영 ───────────────────────────────────
  {
    const anchor = 4_000_000;
    const m = await newMessage();
    // 원장에는 없지만 실제 payload 로는 5초 전에 모션이 나갔다(배포 이전 답변).
    const res = await claim({
      messageId: m, motion: "excited", decidedAt: at(anchor),
      payloadLastMotionAt: at(anchor - 5_000),
    });
    check("F 원장 밖 payload 모션도 쿨다운을 민다", res.granted === false);
    const later = await newMessage();
    const ok = await claim({
      messageId: later, motion: "excited", decidedAt: at(anchor + 60_000),
      payloadLastMotionAt: at(anchor - 5_000),
    });
    check("F 충분히 지난 payload 시각은 막지 않는다", ok.granted);
  }

  // ── G 유저 격리 / fail-close ───────────────────────────────────────────────
  {
    const anchor = 5_000_000;
    const a = await newMessage();
    await claim({ messageId: a, motion: "excited", decidedAt: at(anchor) });
    const b = await newMessage();
    const other = await claim({ messageId: b, userId: USER_B, motion: "excited", decidedAt: at(anchor + 1_000) });
    check("G 다른 유저의 쿨다운은 간섭하지 않는다", other.granted);

    const owned = await newMessage();
    await claim({ messageId: owned, motion: "excited", decidedAt: at(anchor + 100_000) });
    let ownerMismatch = false;
    try { await claim({ messageId: owned, userId: USER_B, motion: "excited", decidedAt: at(anchor + 100_000) }); }
    catch { ownerMismatch = true; }
    check("G 소유자 불일치 재사용은 fail-close", ownerMismatch);

    let badMotion = false;
    const bad = await newMessage();
    try { await claim({ messageId: bad, motion: "sparkle", decidedAt: at(anchor + 200_000) }); }
    catch { badMotion = true; }
    check("G 폐쇄집합 밖 모션 값은 fail-close", badMotion);

    let badInput = false;
    try {
      await db.query(
        "select * from public.claim_baseball_genius_motion($1,$2,$3,$4,$5,$6)",
        [0, USER_A, "excited", at(0), COOLDOWN_MS, null],
      );
    } catch { badInput = true; }
    check("G 잘못된 message_id 는 fail-close", badInput);
  }

  // ── 권한 계약 ──────────────────────────────────────────────────────────────
  {
    const grants = await db.query<{ grantee: string }>(
      `select grantee from information_schema.role_routine_grants
       where routine_name = 'claim_baseball_genius_motion'`,
    );
    const grantees = grants.rows.map((r) => r.grantee);
    check("권한: service_role 에만 EXECUTE",
      grantees.includes("service_role") && !grantees.includes("anon") && !grantees.includes("authenticated"),
      grantees.join(","));
    const rls = await db.query<{ relrowsecurity: boolean }>(
      "select relrowsecurity from pg_class where relname = 'genius_motion_grants'",
    );
    check("권한: 원장 RLS 활성", rls.rows[0]?.relrowsecurity === true);
  }

  await db.close();
  if (failures.length > 0) {
    console.error(`\n❌ genius motion cooldown DB FAIL: ${failures.length}건 — ${failures.join(" | ")}`);
    process.exit(1);
  }
  console.log(`\n✅ genius motion cooldown DB: ${pass} PASS (병렬 race + 멱등 + 경계 + 억제 비전파 + payload 이월 + fail-close)`);
  process.exit(0);
}

void main().catch((error) => {
  console.error("❌ genius motion cooldown DB FAIL:", error);
  process.exit(1);
});
