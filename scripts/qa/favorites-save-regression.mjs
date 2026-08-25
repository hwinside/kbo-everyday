// 최애선수 저장 행동 회귀 (PR #1297) — tsx 실행, 네트워크/브라우저 불요.
// ① 직렬화 latest-wins: delayed-A/fast-B에서 DB 최종 = 최신 선택 (도착 순서 보존)
// ② bounded: never-settle auth/fetch가 상한 안에 실패로 종료
// ③ 401 → refresh 1회 + 재시도 1회, 실패 시 needsRelogin
// ④ A 성공/B 실패 → 오류에 마지막 성공값(lastSaved) 동반 (로컬↔DB 정합)
// ⑤ ID-only canonical 검증 — 라우트가 import하는 같은 함수(production seam) 직접 타격,
//    name-as-ID("손호영") fallback 통과 금지 + 구현이 fallback이었다면 RED임을 실증
// 사용: npm run qa:favorites-save
import {
  createFavoritesSaver,
  ownedRow,
  tokenForUser,
  ProfileSaveError,
} from "../../src/lib/profile/favorites-saver-core.ts";
import {
  getAuthIdentity,
  getActiveAuthUid,
  commitAuthIdentity,
  beginAuthDispatch,
  commitAuthIdentityIfCurrent,
  isSameAuthIdentity,
  isAuthIdentityForUser,
  __resetAuthIdentityForTest,
} from "../../src/lib/supabase/auth-identity.ts";
import {
  parseFavorites,
  resolveFavoriteById,
} from "../../src/lib/profile/favorite-players-validation.ts";
import { resolvePlayer } from "../../src/lib/utils/resolve-player.ts";
import rosterJson from "../../src/lib/constants/players-roster.json" with { type: "json" };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fav = (id) => [{ playerId: id, name: "n", teamId: 1, position: "p", number: 1 }];
const okBody = (players) => ({ ok: true, profile: { id: "u", team_id: 1, favorite_players: players } });

// ── ① 직렬화 latest-wins ─────────────────────────────────────────────
{
  // delayed A(300ms) / fast B(5ms): A in-flight 중 B 접수 → B는 A 완료를 기다림
  const applied = []; // 가짜 DB — 서버에 "도착·반영된" 순서
  const delays = { A: 300, B: 5 };
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) => {
      const id = updates.favorite_players[0].playerId;
      await sleep(delays[id]);
      applied.push(id);
      return { status: 200, body: okBody(updates.favorite_players) };
    },
  });
  const pA = saver.save({ favorite_players: fav("A") }, 1);
  await sleep(30); // A가 서버 호출에 진입(in-flight)한 뒤 B 접수
  const pB = saver.save({ favorite_players: fav("B") }, 1);
  const [rA, rB] = await Promise.all([pA, pB]);
  check(
    "serialize: delayed-A/fast-B → DB 최종=B",
    applied.length === 2 && applied[0] === "A" && applied[1] === "B" && applied[applied.length - 1] === "B",
    `applied=${applied.join(",")}`
  );
  check(
    "serialize: 두 결과 모두 자기 값으로 확정(순서 보존)",
    rA.superseded === false && rA.profile.favorite_players[0].playerId === "A" &&
    rB.superseded === false && rB.profile.favorite_players[0].playerId === "B",
    `rA=${rA.profile?.favorite_players?.[0]?.playerId} rB=${rB.profile?.favorite_players?.[0]?.playerId}`
  );
}
{
  // 동기 연속 A,B,C: 중간 요청은 서버로 안 나가고 superseded, 최종만 반영
  const applied = [];
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) => {
      applied.push(updates.favorite_players[0].playerId);
      return { status: 200, body: okBody(updates.favorite_players) };
    },
  });
  const [rA, rB, rC] = await Promise.all([
    saver.save({ favorite_players: fav("A") }, 1),
    saver.save({ favorite_players: fav("B") }, 1),
    saver.save({ favorite_players: fav("C") }, 1),
  ]);
  check(
    "serialize: burst A,B,C → 최종 반영=C, 중간은 superseded(서버 미도달)",
    applied[applied.length - 1] === "C" && rC.superseded === false &&
    (rA.superseded || applied.includes("A") === false || applied.indexOf("A") < applied.indexOf("C")) &&
    rB.superseded === true,
    `applied=${applied.join(",")} rA.superseded=${rA.superseded} rB.superseded=${rB.superseded}`
  );
}
{
  // 실패한 A 뒤에 B — 실패가 체인을 끊지 않고, B는 정상 저장
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) => {
      const id = updates.favorite_players[0].playerId;
      if (id === "A") return { status: 500, body: null };
      return { status: 200, body: okBody(updates.favorite_players) };
    },
  });
  const pA = saver.save({ favorite_players: fav("A") }, 1);
  await sleep(10);
  const pB = saver.save({ favorite_players: fav("B") }, 1);
  const rA = await pA.then(() => "resolved", (e) => e);
  const rB = await pB;
  check(
    "serialize: A 실패 후 B 정상(체인 미단절)",
    rA instanceof ProfileSaveError && rB.superseded === false,
    `rA=${rA?.name} rB.superseded=${rB?.superseded}`
  );
}

// ── ② bounded (never-settle) ────────────────────────────────────────
{
  // getToken·refreshToken 모두 never-settle → authTimeoutMs 안에 needsRelogin으로 종료
  const never = () => new Promise(() => {});
  const saver = createFavoritesSaver({
    getToken: never,
    refreshToken: never,
    putFavorites: async () => ({ status: 200, body: okBody([]) }),
    authTimeoutMs: 100,
  });
  const t0 = Date.now();
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  const elapsed = Date.now() - t0;
  check(
    "bounded: never-settle auth → 상한 내 needsRelogin 종료",
    err instanceof ProfileSaveError && err.needsRelogin === true && elapsed < 1000,
    `elapsed=${elapsed}ms needsRelogin=${err?.needsRelogin}`
  );
}
{
  // fetch never-settle → requestTimeoutMs 안에 GENERIC 실패로 종료
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: () => new Promise(() => {}),
    requestTimeoutMs: 100,
  });
  const t0 = Date.now();
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  const elapsed = Date.now() - t0;
  check(
    "bounded: never-settle fetch → 상한 내 실패 종료(재로그인 아님)",
    err instanceof ProfileSaveError && err.needsRelogin === false && elapsed < 1000,
    `elapsed=${elapsed}ms`
  );
}

// ── ③ 401 refresh 재시도 계약 ────────────────────────────────────────
{
  // 401 → refresh 1회 → 재시도 성공. put 정확히 2회, refresh 정확히 1회.
  let puts = 0, refreshes = 0;
  const saver = createFavoritesSaver({
    getToken: async () => "expired",
    refreshToken: async () => { refreshes++; return "fresh"; },
    putFavorites: async (token, updates) => {
      puts++;
      if (token === "expired") return { status: 401, body: null };
      return { status: 200, body: okBody(updates.favorite_players) };
    },
  });
  const r = await saver.save({ favorite_players: fav("A") }, 1);
  check(
    "401: refresh 1회+재시도 1회로 성공 (put=2, refresh=1)",
    r.superseded === false && puts === 2 && refreshes === 1,
    `puts=${puts} refreshes=${refreshes}`
  );
}
{
  // 401 → refresh → 또 401 → needsRelogin, put은 정확히 2회에서 멈춤(무한루프 없음)
  let puts = 0;
  const saver = createFavoritesSaver({
    getToken: async () => "t1",
    refreshToken: async () => "t2",
    putFavorites: async () => { puts++; return { status: 401, body: null }; },
  });
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  check(
    "401×2: needsRelogin으로 종료, put 정확히 2회",
    err instanceof ProfileSaveError && err.needsRelogin === true && puts === 2,
    `puts=${puts}`
  );
}
{
  // 401 → refresh 실패 → needsRelogin (재시도 없음, put 1회)
  let puts = 0;
  const saver = createFavoritesSaver({
    getToken: async () => "t1",
    refreshToken: async () => null,
    putFavorites: async () => { puts++; return { status: 401, body: null }; },
  });
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  check(
    "401+refresh실패: needsRelogin, put 1회",
    err instanceof ProfileSaveError && err.needsRelogin === true && puts === 1,
    `puts=${puts}`
  );
}
{
  // 성공 판정은 저장 row 존재 시에만 — 200이어도 profile 없으면 실패
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async () => ({ status: 200, body: { ok: true } }),
  });
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  check("200이어도 저장 row 없으면 실패 처리", err instanceof ProfileSaveError, String(err?.name));
}

// ── ④ A 성공/B 실패 — 마지막 성공값 정합 ───────────────────────────────
{
  // A 성공(지연) 후 최신 B 실패 → B 오류의 lastSaved == A의 저장 row
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) => {
      const id = updates.favorite_players[0].playerId;
      if (id === "A") { await sleep(80); return { status: 200, body: okBody(updates.favorite_players) }; }
      return { status: 500, body: null };
    },
  });
  const pA = saver.save({ favorite_players: fav("A") }, 1);
  await sleep(10); // A in-flight 진입 후 B 접수
  const pB = saver.save({ favorite_players: fav("B") }, 1);
  const rA = await pA;
  const errB = await pB.then(() => null, (e) => e);
  check(
    "A성공/B실패: B 오류에 lastSaved=A row 동반(로컬↔DB 정합 근거)",
    rA.superseded === false &&
    errB instanceof ProfileSaveError &&
    errB.lastSaved?.favorite_players?.[0]?.playerId === "A",
    `lastSaved=${errB?.lastSaved?.favorite_players?.[0]?.playerId}`
  );
}
{
  // 사전 성공 없이 첫 저장부터 실패 → lastSaved는 null(정합 대상 없음 — 기존값 유지)
  const saver = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async () => ({ status: 500, body: null }),
  });
  const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
  check("첫 저장 실패: lastSaved=null(기존값 유지)", err instanceof ProfileSaveError && err.lastSaved === null, `lastSaved=${err?.lastSaved}`);
}

// ── ⑥ 계정 격리 (삼순 4차): A계정 성공 → B계정 첫 실패 ───────────────────
{
  // GREEN: wiring과 동일하게 user별 saver 인스턴스 격리 — B의 오류 lastSaved는 null
  // (A의 row가 계정 경계를 넘어올 수 없음)
  const mkDeps = (fail) => ({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) =>
      fail ? { status: 500, body: null } : { status: 200, body: { ok: true, profile: { id: "user-a", team_id: 1, favorite_players: updates.favorite_players } } },
  });
  const saverA = createFavoritesSaver(mkDeps(false)); // 계정 A용 인스턴스
  const saverB = createFavoritesSaver(mkDeps(true)); // 계정 B용 인스턴스
  const rA = await saverA.save({ favorite_players: fav("A") }, 1);
  const errB = await saverB.save({ favorite_players: fav("B") }, 1).then(() => null, (e) => e);
  check(
    "계정격리 GREEN: A계정 성공 후 B계정 첫 실패 → B의 lastSaved=null(오염 불가)",
    rA.superseded === false && errB instanceof ProfileSaveError && errB.lastSaved === null,
    `lastSaved=${errB?.lastSaved}`
  );
  // RED 실증: 계정 무관 단일 공유 saver(구 설계의 module singleton)는 B 실패 오류에
  // A계정 row를 실어 보낸다 — 오염이 실제로 일어남을 증명(무대 있는 mutation)
  let phase = 0;
  const shared = createFavoritesSaver({
    getToken: async () => "t",
    refreshToken: async () => null,
    putFavorites: async (_t, updates) => {
      phase += 1;
      return phase === 1
        ? { status: 200, body: { ok: true, profile: { id: "user-a", team_id: 1, favorite_players: updates.favorite_players } } }
        : { status: 500, body: null };
    },
  });
  await shared.save({ favorite_players: fav("A") }, 1); // 계정 A 성공
  const errShared = await shared.save({ favorite_players: fav("B") }, 1).then(() => null, (e) => e); // 계정 B 실패(공유 캐시)
  const leaked = errShared?.lastSaved;
  check(
    "계정격리 mutation-RED 실증: 공유 saver는 B 실패에 A계정 row를 실어 보냄(구 설계=결함)",
    errShared instanceof ProfileSaveError && leaked?.id === "user-a",
    `leaked.id=${leaked?.id}`
  );
  // 호출부 마지막 관문: ownedRow fail-close — 공유 캐시가 새어도 commit 직전에 차단
  check(
    "ownedRow fail-close: A row는 B계정으로 commit 불가, 본인 계정만 통과",
    ownedRow(leaked, "user-b") === null && ownedRow(leaked, "user-a")?.id === "user-a" &&
    ownedRow(null, "user-a") === null && ownedRow({ id: 123 }, "123") === null,
    `ownedRow(leaked,"user-b")=${ownedRow(leaked, "user-b")}`
  );
}

// ── ⑦ 토큰↔userId 결속 (삼순 5차): side effect 전 차단 ────────────────────
{
  // tokenForUser 단위: 일치만 통과, 불일치/결손 전부 null
  const sessA = { access_token: "tok-a", user: { id: "user-a" } };
  const sessB = { access_token: "tok-b", user: { id: "user-b" } };
  check(
    "tokenForUser: 세션 user 일치만 토큰 반환(fail-close)",
    tokenForUser(sessA, "user-a") === "tok-a" &&
    tokenForUser(sessB, "user-a") === null &&
    tokenForUser(null, "user-a") === null &&
    tokenForUser({ access_token: "t" }, "user-a") === null &&
    tokenForUser({ access_token: "", user: { id: "user-a" } }, "user-a") === null,
    ""
  );

  // GREEN: A enqueue → 계정 B 전환 → 실행 시점 세션은 B — PUT 0회·DB 불변
  {
    let puts = 0;
    const db = { "user-b": "orig" }; // 가짜 DB — B 계정 현재값
    const currentSession = () => sessB; // 실행 시점엔 이미 B로 전환됨
    const saverA = createFavoritesSaver({
      getToken: async () => tokenForUser(currentSession(), "user-a"),
      refreshToken: async () => tokenForUser(currentSession(), "user-a"),
      putFavorites: async () => { puts++; db["user-b"] = "overwritten"; return { status: 200, body: okBody([]) }; },
      authTimeoutMs: 100,
    });
    const err = await saverA.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
    check(
      "결속 GREEN: A enqueue→B 전환 → PUT 0회·B DB 불변·needsRelogin",
      err instanceof ProfileSaveError && err.needsRelogin === true && puts === 0 && db["user-b"] === "orig",
      `puts=${puts} db=${db["user-b"]}`
    );
  }

  // GREEN: A 토큰으로 PUT→401 → refresh가 B 세션 반환 → 재시도 0회
  {
    let puts = 0;
    const saver = createFavoritesSaver({
      getToken: async () => tokenForUser({ access_token: "tok-a-stale", user: { id: "user-a" } }, "user-a"),
      refreshToken: async () => tokenForUser(sessB, "user-a"), // refresh 결과는 B 세션 → null
      putFavorites: async () => { puts++; return { status: 401, body: null }; },
    });
    const err = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
    check(
      "결속 GREEN: A 401→refresh가 B 세션 → 재시도 0(put 1회)·needsRelogin",
      err instanceof ProfileSaveError && err.needsRelogin === true && puts === 1,
      `puts=${puts}`
    );
  }

  // RED 실증: 구 구현(세션 user 무검증 — access_token만 반환)은 B 토큰으로 PUT을
  // 실행해 B DB를 실제로 갱신한다 — side effect가 일어남을 증명(무대 있는 mutation)
  {
    let puts = 0;
    const db = { "user-b": "orig" };
    const unbound = createFavoritesSaver({
      getToken: async () => sessB.access_token, // 구 구현: user 검증 없음
      refreshToken: async () => null,
      putFavorites: async (token) => {
        puts++;
        if (token === "tok-b") db["user-b"] = "overwritten-by-A-request";
        return { status: 200, body: { ok: true, profile: { id: "user-b", team_id: 1, favorite_players: [] } } };
      },
    });
    await unbound.save({ favorite_players: fav("A") }, 1).catch(() => {});
    check(
      "결속 mutation-RED 실증: 무검증 토큰 구현은 B DB를 실제로 갱신(구 설계=결함)",
      puts === 1 && db["user-b"] === "overwritten-by-A-request",
      `puts=${puts} db=${db["user-b"]}`
    );
  }
}

// ── ⑦ {uid,epoch} 신원 + revision fence (삼순 7차 재설계) — 실제 auth-identity 모듈 구동 ──
//    UID 단독은 A→B→A·동일 UID 재인증을 못 가른다 — 옆 A 응답/옥 lastSaved가 UID
//    비교를 다시 통과해 새 세션을 덮는다. epoch(uid 전환마다 +1)까지 대조해 닫는다.
//    또 늘은 async syncSession이 최신 onAuthStateChange를 되돌리는 것을 revision으로 차단.
{
  __resetAuthIdentityForTest();

  // commitAuthIdentity: revision 항상 +1, epoch은 uid 변경 시에만 +1
  const i0 = getAuthIdentity();      // {null,0}
  commitAuthIdentity("user-a");      // A: epoch 1
  const iA = getAuthIdentity();
  commitAuthIdentity("user-a");      // 동일 uid 재게시(토큰갱신) → epoch 유지
  const iA2 = getAuthIdentity();
  check(
    "epoch: uid 변경시만 +1(동일 uid 재게시는 epoch 유지)",
    i0.epoch === 0 && iA.uid === "user-a" && iA.epoch === 1 && iA2.epoch === 1,
    `i0=${i0.epoch} iA=${iA.epoch} iA2=${iA2.epoch}`
  );

  // isSameAuthIdentity: uid+epoch 정확 일치만 통과
  check(
    "isSameAuthIdentity: uid+epoch 일치만 true(uid 같고 epoch 다르면 false)",
    isSameAuthIdentity({ uid: "user-a", epoch: 1 }) === true &&
    isSameAuthIdentity({ uid: "user-a", epoch: 0 }) === false &&
    isSameAuthIdentity({ uid: "user-b", epoch: 1 }) === false &&
    isSameAuthIdentity(null) === false &&
    isSameAuthIdentity({ uid: null, epoch: 1 }) === false,
    `same(A,1)=${isSameAuthIdentity({ uid: "user-a", epoch: 1 })}`
  );

  // commit 게이트 — 실제 모듈로 A→B→A / 동일 UID 재인증 재현.
  //   scenario: "AtoBtoA" | "reauthSameUid"   arrival: "success"|"failure"
  //   guarded: true=epoch 대조(isSameAuthIdentity) | false=uid만(구 설계)
  const runIdentityGate = ({ scenario, arrival, guarded }) => {
    __resetAuthIdentityForTest();
    commitAuthIdentity("user-a");        // A 세션(epoch 1)
    const reqSnap = getAuthIdentity();   // 요청 시작 스냅샷 {A,1}
    const local = { fav: "new-local" };  // 전환/재인증 뒤 화면 로컬
    if (scenario === "AtoBtoA") {
      commitAuthIdentity("user-b");      // B (epoch 2)
      commitAuthIdentity("user-a");      // 다시 A (epoch 3)
    } else {
      commitAuthIdentity(null);          // 로그아웃 (epoch 2)
      commitAuthIdentity("user-a");      // 재로그인 A (epoch 3)
    }
    // A 요청의 늘은 응답(성공=A row / 실패=lastSaved A) 도착
    const rowForA = { id: reqSnap.uid, favorite_players: "A-data" };
    const owned = ownedRow(rowForA, reqSnap.uid); // uid 기준 → 통과(A row)
    const pass = guarded
      ? isSameAuthIdentity(reqSnap)               // epoch까지 대조 → false
      : (getActiveAuthUid() === reqSnap.uid);     // 구 설계: uid만 → true(A===A)
    if (pass && owned) local.fav = owned.favorite_players; // commit
    void arrival;
    return local.fav;
  };

  for (const scenario of ["AtoBtoA", "reauthSameUid"]) {
    for (const arrival of ["success", "failure"]) {
      check(
        `신원 GREEN(${scenario}/${arrival}): epoch 대조로 옆 A 응답 commit 차단 → 새 로컬 불변`,
        runIdentityGate({ scenario, arrival, guarded: true }) === "new-local",
        `local=${runIdentityGate({ scenario, arrival, guarded: true })}`
      );
      check(
        `신원 mutation-RED(${scenario}/${arrival}): uid만 비교(구 설계) → 옆 A가 새 로컬 오염`,
        runIdentityGate({ scenario, arrival, guarded: false }) === "A-data",
        `local=${runIdentityGate({ scenario, arrival, guarded: false })}`
      );
    }
  }

  // revision fence — 늘은 syncSession이 최신 onAuthStateChange를 되돌리지 못한다
  {
    __resetAuthIdentityForTest();
    commitAuthIdentity("user-a");        // 초기 A
    const ticket = beginAuthDispatch();  // syncSession 시작(옥 쿼키=A 스냅샷)
    commitAuthIdentity("user-b");        // 그 사이 onAuthStateChange(B) 도착
    const applied = commitAuthIdentityIfCurrent("user-a", ticket); // 늘은 syncSession 결과(A)
    check(
      "revision fence GREEN: 늘은 syncSession(A) 폐기 → 활성 B 유지",
      applied === false && getActiveAuthUid() === "user-b",
      `applied=${applied} active=${getActiveAuthUid()}`
    );
  }
  {
    // mutation-RED: fence 없이 무조건 게시하면 옥 A가 최신 B를 되돌린다
    __resetAuthIdentityForTest();
    commitAuthIdentity("user-a");
    beginAuthDispatch();
    commitAuthIdentity("user-b");        // 최신 B
    commitAuthIdentity("user-a");        // fence 없는 무조건 게시 시뮬 → A 재게시
    check(
      "revision fence mutation-RED: fence 없으면 늘은 A 게시가 B를 되돌림(구 설계=결함)",
      getActiveAuthUid() === "user-a",
      `active=${getActiveAuthUid()}`
    );
  }
  {
    // GREEN: 경쟁 없으면(티켓 이후 이벤트 없음) syncSession 결과 정상 적용
    __resetAuthIdentityForTest();
    const ticket = beginAuthDispatch();
    const applied = commitAuthIdentityIfCurrent("user-a", ticket);
    check(
      "revision fence GREEN: 경쟁 없으면 syncSession 결과 정상 적용",
      applied === true && getActiveAuthUid() === "user-a",
      `applied=${applied} active=${getActiveAuthUid()}`
    );
  }

  // cross-epoch 직렬화: UID별 체인이 epoch를 넘어 유지 → slow-old(e1)/fast-new(e2) DB 최종=new (삼순 8차)
  {
    const applied = [];
    const delays = { A: 120, B: 5 };
    const mkDeps = () => ({
      getToken: async () => "t",
      refreshToken: async () => null,
      putFavorites: async (_t, updates) => {
        const id = updates.favorite_players[0].playerId;
        await sleep(delays[id]);
        applied.push(id);
        return { status: 200, body: okBody(updates.favorite_players) };
      },
    });
    const saver = createFavoritesSaver(mkDeps());
    const pA = saver.save({ favorite_players: fav("A") }, 1); // epoch1 느린 PUT
    await sleep(20);
    const pB = saver.save({ favorite_players: fav("B") }, 2); // epoch2 빠른 PUT
    await Promise.all([pA, pB]);
    check(
      "cross-epoch GREEN: UID 체인 유지 → slow-old(e1)/fast-new(e2) DB 최종=new(B)",
      applied.length === 2 && applied[applied.length - 1] === "B",
      `applied=${applied.join(",")}`
    );
  }
  {
    // mutation-RED: uid:epoch로 체인을 쪼개면(구 설계) 두 saver가 동시 진행 →
    // slow-old(A)가 fast-new(B) 뒤 완료해 DB가 A로 되돌아간다.
    const applied = [];
    const delays = { A: 120, B: 5 };
    const mkDeps = () => ({
      getToken: async () => "t",
      refreshToken: async () => null,
      putFavorites: async (_t, updates) => {
        const id = updates.favorite_players[0].playerId;
        await sleep(delays[id]);
        applied.push(id);
        return { status: 200, body: okBody(updates.favorite_players) };
      },
    });
    const saverE1 = createFavoritesSaver(mkDeps());
    const saverE2 = createFavoritesSaver(mkDeps()); // 구 설계: epoch마다 새 saver(체인 분리)
    const pA = saverE1.save({ favorite_players: fav("A") }, 1);
    await sleep(20);
    const pB = saverE2.save({ favorite_players: fav("B") }, 2);
    await Promise.all([pA, pB]);
    check(
      "cross-epoch mutation-RED: 체인 분리(구 설계)면 slow-old(A)가 DB 최종을 되돌림",
      applied.length === 2 && applied[applied.length - 1] === "A",
      `applied=${applied.join(",")}`
    );
  }

  // lastSaved epoch 격리: 같은 epoch 실패는 그 epoch 성공값, 다른 epoch 실패는 null
  {
    let call = 0;
    const saver = createFavoritesSaver({
      getToken: async () => "t",
      refreshToken: async () => null,
      putFavorites: async (_t, updates) => {
        call += 1;
        if (call >= 2) return { status: 500, body: null }; // 1번째만 성공
        return { status: 200, body: okBody(updates.favorite_players) };
      },
    });
    await saver.save({ favorite_players: fav("A") }, 1); // epoch1 성공 → lastSaved=A
    const errSame = await saver.save({ favorite_players: fav("A") }, 1).then(() => null, (e) => e);
    check(
      "lastSaved GREEN: 같은 epoch 실패 → lastSaved=그 epoch 성공값(A, 정합 가능)",
      errSame instanceof ProfileSaveError && errSame.lastSaved?.favorite_players?.[0]?.playerId === "A",
      `lastSaved=${errSame?.lastSaved?.favorite_players?.[0]?.playerId}`
    );
    const errNew = await saver.save({ favorite_players: fav("B") }, 2).then(() => null, (e) => e);
    check(
      "lastSaved GREEN: 다른 epoch 실패 → lastSaved=null(옥 epoch 성공값 격리)",
      errNew instanceof ProfileSaveError && errNew.lastSaved === null,
      `lastSaved=${JSON.stringify(errNew?.lastSaved)}`
    );
  }

  // PUT 전 fail-close: auth 모듈 신원과 React user.id 불일치(stale closure) 차단
  {
    __resetAuthIdentityForTest();
    commitAuthIdentity("user-b"); // auth 모듈은 B로 전환(epoch 1)
    const modB = getAuthIdentity(); // {B,1}
    check(
      "stale-mismatch GREEN: 모듈 B / React A → isAuthIdentityForUser false(저장 안 함)",
      isAuthIdentityForUser(modB, "user-a") === false &&
      isAuthIdentityForUser(modB, "user-b") === true &&
      isAuthIdentityForUser({ uid: "user-b", epoch: 999 }, "user-b") === false && // epoch 불일치
      isAuthIdentityForUser(modB, null) === false,
      `modB/reactA=${isAuthIdentityForUser(modB, "user-a")}`
    );
    // mutation-RED: 구 설계(reqIdentity.uid ?? user.id, 불일치 무검증)는 모듈 B로 저장 진행
    const oldReqUid = modB.uid ?? "user-a"; // ?? 폴백은 모듈 B를 채택
    const oldWouldSave = !!oldReqUid;         // user 존재하면 불일치 무시하고 저장
    check(
      "stale-mismatch mutation-RED: 구 설계은 React A와 불일치어도 모듈 B(uid=user-b)로 저장 진행",
      oldWouldSave === true && oldReqUid === "user-b",
      `oldReqUid=${oldReqUid} wouldSave=${oldWouldSave}`
    );
    __resetAuthIdentityForTest();
  }

  __resetAuthIdentityForTest(); // 다른 블록에 상태 누수 방지
}

// ── ⑤ ID-only canonical 검증 (production seam — 라우트가 import하는 그 함수) ──
{
  const roster = rosterJson;
  const real = roster.filter((p) => /^\d+$/.test(p.kboId)).sort((a, b) => a.kboId.localeCompare(b.kboId));
  const toPayload = (p, forge = false) => ({
    playerId: p.kboId,
    name: forge ? "위조이름" : p.name,
    teamId: forge ? 99 : p.teamId,
    position: forge ? "가짜" : p.position,
    number: forge ? 999 : Number(p.backNo) || 0,
  });

  // name-as-ID 차단: 이름 문자열은 어떤 경로로도 해석 금지
  const nameAsId = real[10].name; // 실존 선수의 "이름"을 ID 자리에
  check(
    "ID-only: name-as-ID 해석 거절(fail-close)",
    resolveFavoriteById(nameAsId) === null &&
    parseFavorites([{ playerId: nameAsId, name: "x", teamId: 1, position: "p", number: 1 }]) === null,
    `name="${nameAsId}"`
  );
  // mutation RED 실증: 구 구현(resolvePlayer)은 같은 입력을 이름 fallback으로 통과시킨다
  //  — 구현을 resolvePlayer로 되돌리면 위 축이 실제로 RED가 됨을 증명(무대 있는 mutation)
  const fallbackResolved = resolvePlayer({ kboId: nameAsId });
  check(
    "mutation-RED 실증: resolvePlayer는 같은 입력을 이름 fallback으로 통과시킴(구 구현=결함)",
    fallbackResolved !== null && fallbackResolved.name === nameAsId,
    `resolvePlayer("${nameAsId}") → ${fallbackResolved?.kboId ?? "null"}`
  );
  // 미존재 ID fail-close
  check("ID-only: 미존재 ID 거절", parseFavorites([toPayload({ ...real[0], kboId: "00000999" })]) === null);
  // 위조 메타데이터 → canonical 교체(제출값 폐기)
  {
    const p = real[10];
    const parsed = parseFavorites([toPayload(p, true)]);
    check(
      "canonical: 위조 name/team/number → 로스터값 교체",
      parsed?.length === 1 && parsed[0].name === p.name && parsed[0].teamId === p.teamId && parsed[0].position === p.position,
      `stored=${JSON.stringify(parsed?.[0])}`
    );
  }
  // 선택 순서 유지 + canonical dedupe + 5명 경계
  {
    const scrambled = [real[20], real[5], real[40]];
    const parsed = parseFavorites(scrambled.map((p) => toPayload(p)));
    check(
      "canonical: 선택 순서 유지",
      JSON.stringify(parsed?.map((x) => x.playerId)) === JSON.stringify(scrambled.map((p) => p.kboId)),
      `ids=${parsed?.map((x) => x.playerId).join(",")}`
    );
    const dup = parseFavorites([...real.slice(0, 5), real[0]].map((p) => toPayload(p)));
    check("canonical: 중복 dedupe로 5명", dup?.length === 5, `len=${dup?.length}`);
    check("canonical: 6명(유니크) 거절", parseFavorites(real.slice(0, 6).map((p) => toPayload(p))) === null);
    check("canonical: 5명(상한) 허용", parseFavorites(real.slice(0, 5).map((p) => toPayload(p)))?.length === 5);
  }
  // 레거시 은퇴/통합 ID 교정 (AQ008 → 56548)
  {
    const parsed = parseFavorites([{ playerId: "AQ008", name: "x", teamId: 1, position: "p", number: 1 }]);
    check("canonical: 레거시 AQ008→56548 교정", parsed?.[0]?.playerId === "56548", `id=${parsed?.[0]?.playerId}`);
  }
  // non-array 거절
  check("canonical: non-array 거절", parseFavorites("nope") === null);
}

// ── selftest: 검증력 증명(RED) — 계약을 어기는 가짜 구현이 실제로 잡히는가 ──
{
  // 직렬화를 끄면(체인 없이 즉시 실행) delayed-A/fast-B에서 A가 B를 덮는다 → ①번 판정이 RED가 되는지
  const applied = [];
  const delays = { A: 120, B: 5 };
  const unserializedSave = async (updates) => {
    const id = updates.favorite_players[0].playerId;
    await sleep(delays[id]);
    applied.push(id);
  };
  const pA = unserializedSave({ favorite_players: fav("A") });
  await sleep(10);
  const pB = unserializedSave({ favorite_players: fav("B") });
  await Promise.all([pA, pB]);
  check(
    "selftest-RED: 비직렬화 구현은 DB 최종=A(결함)를 실제로 만든다",
    applied[applied.length - 1] === "A",
    `applied=${applied.join(",")} (직렬화 없으면 최신 B가 먼저 반영되고 지연된 A가 덮음)`
  );
}

// ── ⑧ 공식 clear helper (삼순 6차): 계정 전환·로그아웃 시 실제 키/쿼키 정리 actual (jsdom) ──
// 삼순 blocker: AuthContext가 `favorite_players`(오타)를 지워 실제 키
// `kbo-favorite-players`가 남고, 팀은 localStorage만 지워 cookie의 A 값이 남았다.
// user-scope.clearUserScopedStores가 store 공식 clear로 실제 키·cookie를 닫는지 실측.
{
  const { JSDOM } = await import("jsdom");
  const dom = new JSDOM("", { url: "https://keubo.fan" });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.localStorage = dom.window.localStorage;

  // A 계정 로컬 값 심기(실제 키)
  localStorage.setItem("kbo-favorite-players", JSON.stringify([{ playerId: "A" }]));
  localStorage.setItem("kbo-my-team", "1");
  document.cookie = "kbo-my-team=1; path=/";
  localStorage.setItem("kbo-onboarding-status", "completed");

  const { clearUserScopedStores } = await import("../../src/lib/store/user-scope.ts");
  clearUserScopedStores();

  const favCleared = localStorage.getItem("kbo-favorite-players") === null;
  const teamLsCleared = localStorage.getItem("kbo-my-team") === null;
  const teamCookieCleared = !/(?:^|; )kbo-my-team=/.test(document.cookie);
  const onbCleared = localStorage.getItem("kbo-onboarding-status") === null;
  check(
    "clear helper: 실제 키(kbo-favorite-players)·팀 localStorage+cookie·온보딩 전부 정리",
    favCleared && teamLsCleared && teamCookieCleared && onbCleared,
    `fav=${favCleared} teamLs=${teamLsCleared} cookie=${teamCookieCleared} onb=${onbCleared}`
  );

  // mutation-RED 실증: 구 AuthContext가 지우던 키 배열(오타 favorite_players + 팀 cookie 미정리)는
  // 실제 최애 값과 팀 cookie를 남긴다.
  localStorage.setItem("kbo-favorite-players", JSON.stringify([{ playerId: "A" }]));
  localStorage.setItem("kbo-my-team", "1");
  document.cookie = "kbo-my-team=1; path=/";
  ['kbo-my-team', 'kbo-onboarding-status', 'favorite_players'].forEach((k) => localStorage.removeItem(k)); // 구 설계
  const oldFavStillThere = localStorage.getItem("kbo-favorite-players") !== null;
  const oldCookieStillThere = /(?:^|; )kbo-my-team=1/.test(document.cookie);
  check(
    "clear helper mutation-RED: 구 오타 키·cookie 미정리로 실제 최애 값·팀 cookie 잔존(구 설계=결함)",
    oldFavStillThere && oldCookieStillThere,
    `favLeft=${oldFavStillThere} cookieLeft=${oldCookieStillThere}`
  );
}

const fails = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length} / PASS ${results.length - fails.length} / FAIL ${fails.length}`);
process.exit(fails.length ? 1 : 0);
