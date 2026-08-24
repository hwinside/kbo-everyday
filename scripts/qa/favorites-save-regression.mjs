// 최애선수 저장 행동 회귀 (PR #1297 삼순 NO-GO 3축) — tsx 실행, 네트워크/브라우저 불요.
// ① 직렬화 latest-wins: delayed-A/fast-B에서 DB 최종 = 최신 선택 (도착 순서 보존)
// ② bounded: never-settle auth/fetch가 상한 안에 실패로 종료
// ③ 401 → refresh 1회 + 재시도 1회, 실패 시 needsRelogin
// 사용: npm run qa:favorites-save
import {
  createFavoritesSaver,
  ProfileSaveError,
} from "../../src/lib/profile/favorites-saver-core.ts";

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
  const pA = saver.save({ favorite_players: fav("A") });
  await sleep(30); // A가 서버 호출에 진입(in-flight)한 뒤 B 접수
  const pB = saver.save({ favorite_players: fav("B") });
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
    saver.save({ favorite_players: fav("A") }),
    saver.save({ favorite_players: fav("B") }),
    saver.save({ favorite_players: fav("C") }),
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
  const pA = saver.save({ favorite_players: fav("A") });
  await sleep(10);
  const pB = saver.save({ favorite_players: fav("B") });
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
  const err = await saver.save({ favorite_players: fav("A") }).then(() => null, (e) => e);
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
  const err = await saver.save({ favorite_players: fav("A") }).then(() => null, (e) => e);
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
  const r = await saver.save({ favorite_players: fav("A") });
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
  const err = await saver.save({ favorite_players: fav("A") }).then(() => null, (e) => e);
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
  const err = await saver.save({ favorite_players: fav("A") }).then(() => null, (e) => e);
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
  const err = await saver.save({ favorite_players: fav("A") }).then(() => null, (e) => e);
  check("200이어도 저장 row 없으면 실패 처리", err instanceof ProfileSaveError, String(err?.name));
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

const fails = results.filter((r) => !r.ok);
console.log(`\nTOTAL ${results.length} / PASS ${results.length - fails.length} / FAIL ${fails.length}`);
process.exit(fails.length ? 1 : 0);
