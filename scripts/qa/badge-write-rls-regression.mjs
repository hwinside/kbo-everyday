#!/usr/bin/env node
/**
 * user_badges 쓰기 권한 회귀 — 한정 배지 자가 수여 fail-close 검증.
 *
 * 검증 항목 (실제 Supabase 운영 DB, disposable 계정):
 *   1. 일반 로그인 사용자(authenticated JWT)가 자기 user_id 로 `chairman` 직접 INSERT → 거부
 *   2. 동일 사용자가 `chairman-spouse` 직접 INSERT → 거부
 *   3. 동일 사용자가 일반 배지(`debut`) 직접 INSERT → 거부 (쓰기 경로는 service-role 전용)
 *   4. service-role 수여 upsert → 성공
 *   5. anon 공개 조회로 수여된 row 확인 (프로필이 실제 읽는 경로)
 *   6. 정상 배지 획득 경로(service-role 엔진) 비회귀 — service-role 일반 배지 upsert 성공
 *   7. 검증 후 disposable 계정/행 전량 정리
 *
 * 사용:
 *   node scripts/qa/badge-write-rls-regression.mjs            # 기대: 마이그레이션 적용 후 PASS
 *   EXPECT=open node scripts/qa/badge-write-rls-regression.mjs # 마이그레이션 적용 전 RED 재현 확인용
 *
 * env: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
 * env 누락 시 fail-close (검증 불가를 PASS 로 넘기지 않는다).
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const URL_BASE = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const EXPECT = process.env.EXPECT === "open" ? "open" : "closed";

for (const [name, value] of [
  ["NEXT_PUBLIC_SUPABASE_URL", URL_BASE],
  ["NEXT_PUBLIC_SUPABASE_ANON_KEY", ANON],
  ["SUPABASE_SERVICE_ROLE_KEY", SERVICE],
]) {
  if (!value) {
    console.error(`badge write rls regression: FAIL — ${name} 미설정 (검증 불가는 실패로 처리)`);
    process.exit(1);
  }
}

const EXCLUSIVE_IDS = ["chairman", "chairman-spouse"];
const NORMAL_ID = "debut";

async function rest(path, { method = "GET", key, jwt, body, prefer } = {}) {
  const headers = { apikey: key, Authorization: `Bearer ${jwt || key}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${URL_BASE}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, text, json };
}

async function auth(path, { method = "POST", key, jwt, body } = {}) {
  const res = await fetch(`${URL_BASE}/auth/v1/${path}`, {
    method,
    headers: {
      apikey: key,
      Authorization: `Bearer ${jwt || key}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-json */ }
  return { status: res.status, ok: res.ok, text, json };
}

async function main() {
  const stamp = Date.now();
  const email = `qa-badge-rls-${stamp}@keubo-qa.invalid`;
  const password = `Qa!${randomUUID()}`;
  let userId = null;

  try {
    // --- disposable 계정 생성 (service role) ---
    const created = await auth("admin/users", {
      key: SERVICE,
      body: { email, password, email_confirm: true },
    });
    assert.ok(created.ok, `disposable user 생성 실패: ${created.status} ${created.text}`);
    userId = created.json.id;
    console.log(`  disposable user: ${userId} (${email})`);

    // profiles FK 충족 — user_badges.user_id 는 profiles(id) 참조
    const profile = await rest("profiles", {
      method: "POST",
      key: SERVICE,
      prefer: "return=representation",
      body: {
        id: userId,
        nickname: `QA배지${stamp % 100000}`,
        team_id: 1,
      },
    });
    assert.ok(profile.ok, `disposable profile 생성 실패: ${profile.status} ${profile.text}`);

    // --- 로그인해서 authenticated JWT 확보 ---
    const signIn = await auth("token?grant_type=password", {
      key: ANON,
      body: { email, password },
    });
    assert.ok(signIn.ok, `disposable 로그인 실패: ${signIn.status} ${signIn.text}`);
    const jwt = signIn.json.access_token;
    assert.ok(jwt, "access_token 없음");

    // --- (1)(2)(3) authenticated 직접 INSERT 는 전부 거부되어야 한다 ---
    const selfInsertResults = [];
    for (const badgeId of [...EXCLUSIVE_IDS, NORMAL_ID]) {
      const r = await rest("user_badges", {
        method: "POST",
        key: ANON,
        jwt,
        prefer: "return=representation",
        body: { user_id: userId, badge_id: badgeId },
      });
      selfInsertResults.push({ badgeId, status: r.status, ok: r.ok });
      console.log(`  self-insert ${badgeId}: ${r.status} ${r.ok ? "ACCEPTED" : "REJECTED"}`);
    }

    // 실제 row 로 교차 확인 (status 만 믿지 않는다)
    const afterSelf = await rest(
      `user_badges?user_id=eq.${userId}&select=badge_id`,
      { key: SERVICE }
    );
    assert.ok(afterSelf.ok, `self-insert 후 조회 실패: ${afterSelf.text}`);
    const selfRows = (afterSelf.json || []).map(r => r.badge_id).sort();

    if (EXPECT === "open") {
      // 마이그레이션 적용 전 RED 재현: 자가 수여가 실제로 뚫린다는 증거
      assert.ok(
        selfRows.some(id => EXCLUSIVE_IDS.includes(id)),
        `EXPECT=open 인데 한정 배지 자가 수여가 이미 막혀 있다 (rows=${JSON.stringify(selfRows)})`
      );
      console.log(`  [EXPECT=open] RED 재현 확인 — 자가 수여된 row: ${JSON.stringify(selfRows)}`);
    } else {
      assert.deepEqual(
        selfRows,
        [],
        `authenticated 직접 INSERT 가 열려 있다 (rows=${JSON.stringify(selfRows)}, statuses=${JSON.stringify(selfInsertResults)})`
      );
      for (const r of selfInsertResults) {
        assert.equal(r.ok, false, `${r.badgeId} self-insert 가 ${r.status} 로 수락됨`);
      }
      console.log("  self-insert 전건 거부 + row 0 확인");
    }

    // 정리 후 service-role 수여 검증
    await rest(`user_badges?user_id=eq.${userId}`, { method: "DELETE", key: SERVICE });

    // --- (4)(6) service-role 수여는 성공해야 한다 (한정/일반 모두) ---
    const award = await rest("user_badges", {
      method: "POST",
      key: SERVICE,
      prefer: "resolution=merge-duplicates,return=representation",
      body: [
        { user_id: userId, badge_id: "chairman" },
        { user_id: userId, badge_id: NORMAL_ID },
      ],
    });
    assert.ok(award.ok, `service-role 수여 실패: ${award.status} ${award.text}`);
    assert.equal(award.json.length, 2, "service-role 수여 row 수 불일치");
    console.log("  service-role 수여(chairman + 일반 배지) 성공");

    // --- (5) anon 공개 조회 — 프로필이 실제 읽는 경로 ---
    const anonRead = await rest(
      `user_badges?user_id=eq.${userId}&select=badge_id,earned_at`,
      { key: ANON }
    );
    assert.ok(anonRead.ok, `anon 조회 실패: ${anonRead.status} ${anonRead.text}`);
    const anonIds = (anonRead.json || []).map(r => r.badge_id).sort();
    assert.deepEqual(anonIds, ["chairman", NORMAL_ID].sort(), `anon 조회 결과 불일치: ${JSON.stringify(anonIds)}`);
    console.log("  anon 공개 조회에서 수여 배지 노출 확인");

    // --- (3-b) authenticated 가 남의/자기 row 를 UPDATE/DELETE 할 수 없어야 한다 ---
    const del = await rest(`user_badges?user_id=eq.${userId}&badge_id=eq.chairman`, {
      method: "DELETE",
      key: ANON,
      jwt,
    });
    const afterDel = await rest(
      `user_badges?user_id=eq.${userId}&badge_id=eq.chairman&select=badge_id`,
      { key: SERVICE }
    );
    assert.equal(afterDel.json?.length, 1, `authenticated DELETE 로 배지가 삭제됨 (status=${del.status})`);
    console.log("  authenticated DELETE 무력 확인");

    console.log(
      EXPECT === "open"
        ? "badge write rls regression: RED 재현 완료 (마이그레이션 미적용 상태 증거)"
        : "badge write rls regression: PASS (자가 수여 fail-close / service-role 수여·anon 조회 정상)"
    );
  } finally {
    if (userId) {
      await rest(`user_badges?user_id=eq.${userId}`, { method: "DELETE", key: SERVICE });
      await rest(`profiles?id=eq.${userId}`, { method: "DELETE", key: SERVICE });
      await auth(`admin/users/${userId}`, { method: "DELETE", key: SERVICE });
      const left = await rest(`user_badges?user_id=eq.${userId}&select=badge_id`, { key: SERVICE });
      const leftProfile = await rest(`profiles?id=eq.${userId}&select=id`, { key: SERVICE });
      console.log(
        `  cleanup: badges=${(left.json || []).length} profile=${(leftProfile.json || []).length} (둘 다 0이어야 정상)`
      );
    }
  }
}

main().catch(err => {
  console.error("badge write rls regression: FAIL");
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
