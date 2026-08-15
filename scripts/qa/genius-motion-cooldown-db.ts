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
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

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
  const db = new PGlite({ extensions: { btree_gist } });
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

  // ── A 병렬/역순/동시각 → 부여 정확히 1건 ───────────────────────────────────
  //   ⚠️ advisory lock 은 **처리 순서**만 직렬화한다. 도착 순서는 보장하지 않으므로
  //   "나중 시각이 먼저 처리되는" 역순과 "동일 시각"을 반드시 함께 검사해야 한다
  //   (삼순 #1202 2차 P0 — 단방향 `decided_at <` 판정이면 둘 다 통과한다).
  const grantedCountFor = async (offsets: number[], label: string) => {
    const anchorBase = nextId * 1_000_000; // 케이스마다 시간축을 분리
    const results = await Promise.all(offsets.map(async (offset) => {
      const id = await newMessage();
      return claim({ messageId: id, motion: "excited", decidedAt: at(anchorBase + offset) });
    }));
    const granted = results.filter((r) => r.granted).length;
    if (granted !== 1) console.error(`    ↳ ${label}: granted=${granted}`);
    return granted;
  };
  {
    check("A 병렬 2건(정순 t, t+10ms) → 부여 정확히 1건",
      await grantedCountFor([0, 10], "정순") === 1);
    // 핵심 반례: 나중 시각이 **먼저** 처리된다.
    check("A 역순 처리(later-first → earlier) → 부여 정확히 1건",
      await grantedCountFor([10, 0], "역순") === 1);
    check("A 동일 timestamp 2건 → 부여 정확히 1건",
      await grantedCountFor([0, 0], "동시각") === 1);
    check("A 동일 timestamp 4건 → 부여 정확히 1건",
      await grantedCountFor([0, 0, 0, 0], "동시각 4건") === 1);
    // 순서 permutation 전수 — 어떤 순서로 도착해도 결과가 같아야 한다.
    const perms = [[0, 5_000, 10_000], [10_000, 5_000, 0], [5_000, 0, 10_000], [10_000, 0, 5_000]];
    let permOk = true;
    for (const perm of perms) {
      if (await grantedCountFor(perm, `perm ${perm.join(",")}`) !== 1) permOk = false;
    }
    check("A 도착 순서 permutation 전수 → 항상 정확히 1건", permOk);
    // 독립 세션 병렬 — 같은 커넥션 큐가 아니라 별도 연결에서 동시에 때린다.
    {
      const anchorBase = nextId * 1_000_000;
      const ids = [await newMessage(), await newMessage()];
      const [r1, r2] = await Promise.all([
        db.query("select * from public.claim_baseball_genius_motion($1,$2,$3,$4,$5,$6)",
          [ids[0], USER_A, "excited", at(anchorBase + 20), COOLDOWN_MS, null]),
        db.query("select * from public.claim_baseball_genius_motion($1,$2,$3,$4,$5,$6)",
          [ids[1], USER_A, "headspin", at(anchorBase), COOLDOWN_MS, null]),
      ]) as Array<{ rows: Array<{ granted: boolean }> }>;
      const granted = [r1.rows[0], r2.rows[0]].filter((r) => r.granted).length;
      check("A 독립 호출 병렬(역순 시각) → 부여 정확히 1건", granted === 1, `granted=${granted}`);
    }
    // 물리 안전망: 판정을 우회한 직접 INSERT 도 30초 창 중첩이면 저장 자체가 불가능하다.
    {
      const anchorBase = nextId * 1_000_000;
      const okId = await newMessage();
      await claim({ messageId: okId, motion: "excited", decidedAt: at(anchorBase) });
      const dupId = await newMessage();
      let blocked = false;
      try {
        await db.query(
          `insert into public.genius_motion_grants(message_id, user_id, motion, granted, decided_at, cooldown_until)
           values ($1,$2,'excited',true,$3,$4)`,
          [dupId, USER_A, at(anchorBase + 1_000), at(anchorBase + 1_000 + COOLDOWN_MS)],
        );
      } catch { blocked = true; }
      check("A EXCLUDE 제약: 판정 우회 직접 INSERT 도 물리적으로 차단", blocked);
    }
  }

  // ── A' 안전망 OFF — 판정 로직 단독으로도 역순·동시각을 막는가 ────────────────
  //   EXCLUDE 는 최후 방어선이다. 제약이 결과를 지켜주면 판정이 단방향으로 퇴화해도
  //   게이트가 GREEN 이 되므로(축 오염), 제약을 끄고 **판정만** 검증한다.
  {
    await db.exec("alter table public.genius_motion_grants drop constraint genius_motion_grants_cooldown_excl");
    try {
      const cases: Array<[string, number[]]> = [
        ["역순", [10, 0]],
        ["동시각", [0, 0]],
        ["정순", [0, 10]],
      ];
      let ok = true;
      for (const [label, offsets] of cases) {
        const anchorBase = 900_000_000 + nextId * 1_000_000;
        const results = await Promise.all(offsets.map(async (offset) => {
          const id = await newMessage();
          return claim({ messageId: id, motion: "excited", decidedAt: at(anchorBase + offset) });
        }));
        const granted = results.filter((r) => r.granted).length;
        if (granted !== 1) { ok = false; console.error(`    ↳ 안전망 OFF ${label}: granted=${granted}`); }
      }
      check("A' 안전망 OFF 상태에서도 판정 단독으로 정확히 1건(양방향 판정)", ok);
    } finally {
      await db.exec(`alter table public.genius_motion_grants
        add constraint genius_motion_grants_cooldown_excl
        exclude using gist (user_id with =, tstzrange(decided_at, cooldown_until, '[)') with &&)
        where (granted)`);
    }
  }

  // ── B 동일 message_id 재시도 → 첫 판정 재생 (멱등) ─────────────────────────
  {
    const m = await newMessage();
    const first = await claim({ messageId: m, motion: "bored", decidedAt: at(120_000) });
    // durable ready 재시도 — 시각이 더 흘렀어도 첫 판정을 그대로 재생해야 한다.
    // ⚠️ 멱등이 깨지면 재판정이 새 INSERT 를 시도해 PK 위반으로 **예외**가 난다.
    //    예외를 그대로 던지면 이 체크 이름이 로그에 안 남아 mutation evidence 가 사라진다.
    let retry: { motion: string | null; granted: boolean } | null = null;
    let retryError: string | null = null;
    try { retry = await claim({ messageId: m, motion: "bored", decidedAt: at(600_000) }); }
    catch (error) { retryError = (error as Error).message; }
    check("B 동일 id 재시도 → 같은 판정 재생(멱등)",
      retryError === null && first.granted && retry?.granted === true && retry?.motion === first.motion,
      retryError ?? `first=${first.motion}/${first.granted} retry=${retry?.motion}/${retry?.granted}`);
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
    const anchor = 1_000_000_000;
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
    const anchor = 2_000_000_000;
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
    const anchor = 3_000_000_000;
    const knowledge = await newMessage();
    const kres = await claim({ messageId: knowledge, motion: null, decidedAt: at(anchor) });
    check("E 모션 대상 아님 → granted=false·motion=null", kres.granted === false && kres.motion === null);
    const greet = await newMessage();
    const gres = await claim({ messageId: greet, motion: "excited", decidedAt: at(anchor + 1_000) });
    check("E 직후 인사에는 모션이 부여된다(지식 답변이 쿨다운을 밀지 않음)", gres.granted);
  }

  // ── F 원장 이전 payload 모션 시각도 반영 ───────────────────────────────────
  {
    const anchor = 4_000_000_000;
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
    const anchor = 5_000_000_000;
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
