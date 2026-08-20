/**
 * native-session-backup-smoke — 네이티브 세션 백업/복구 모듈 행위 검증.
 *
 * 대상: src/lib/capacitor/session-backup.ts
 * 실행: npm run qa:native-session-backup
 *
 * 각 케이스는 해당 안전 계약이 깨지면 그 자리에서 FAIL 을 낸다 (행위 기반 —
 * 소스 문면 매칭 없음). 주입 브릿지(window.Capacitor)를 케이스별로 갈아끼우며
 * 다음을 검증한다:
 * - 웹/구버전 바이너리 no-op / 왕복 / 손상 데이터 / hang 상한
 * - 복원 의미론: 확정적 refresh 거부만 백업 삭제, transient(error·throw·timeout)는 보존
 * - 세션 획득 사다리: 쿠키/pending 세션 존재 시 네이티브 read 0회 (정상 로그인 무영향)
 * - 로그아웃 fence: signOut 중 늦은 SIGNED_IN/TOKEN_REFRESHED 가 백업을 못 되살림
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type StoreCall = { method: string; key: string; value?: string };

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ✅ ${name}`);
  } else {
    failures++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function makeBridge(opts?: {
  store?: Map<string, string>;
  calls?: StoreCall[];
  hangGet?: boolean;
  omitPlugin?: boolean;
}) {
  const store = opts?.store ?? new Map<string, string>();
  const calls = opts?.calls ?? [];
  const SecureSessionStore = {
    async get({ key }: { key: string }) {
      calls.push({ method: "get", key });
      if (opts?.hangGet) return new Promise<never>(() => {});
      return { value: store.get(key) ?? null };
    },
    async set({ key, value }: { key: string; value: string }) {
      calls.push({ method: "set", key, value });
      store.set(key, value);
    },
    async remove({ key }: { key: string }) {
      calls.push({ method: "remove", key });
      store.delete(key);
    },
  };
  return {
    bridge: {
      isNativePlatform: () => true,
      getPlatform: () => "ios",
      Plugins: opts?.omitPlugin ? {} : { SecureSessionStore },
    },
    store,
    calls,
  };
}

function setWindow(bridge: unknown) {
  if (bridge === null) {
    delete (globalThis as any).window;
    return;
  }
  (globalThis as any).window = { Capacitor: bridge };
}

/** backupSessionTokens 는 fire-and-forget(void) 호출이 있어 마이크로태스크 정착 대기 */
const settle = () => new Promise(r => setTimeout(r, 20));

async function main() {
  const mod = await import("../../src/lib/capacitor/session-backup");
  const tokens = { access_token: "at-1", refresh_token: "rt-1" };

  console.log("[1] 웹(브릿지 없음) — 전부 no-op, throw 없음");
  setWindow(null);
  await mod.backupSessionTokens(tokens);
  check("backup no-op", true);
  check("read null", (await mod.readSessionBackup()) === null);
  await mod.clearSessionBackup();
  check("clear no-op", true);

  console.log("[2] 구버전 바이너리(네이티브인데 SecureSessionStore 플러그인 없음) — no-op");
  {
    const { bridge } = makeBridge({ omitPlugin: true });
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    check("read null (plugin 없음)", (await mod.readSessionBackup()) === null);
  }

  console.log("[3] 백업 → 읽기 왕복");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    check("네이티브 저장소에 기록됨", store.size === 1);
    const read = await mod.readSessionBackup();
    check(
      "왕복 일치",
      read?.access_token === "at-1" && read?.refresh_token === "rt-1",
      JSON.stringify(read),
    );
  }

  console.log("[4] 불완전 토큰은 백업 거부 (부분 세션으로 덮어쓰기 방지)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens({ access_token: "", refresh_token: "rt-x" });
    await mod.backupSessionTokens({ access_token: "at-x", refresh_token: "" } as any);
    check("기록 0건", store.size === 0, `size=${store.size}`);
  }

  console.log("[5] 손상된 백업(JSON 깨짐/필드 누락) → null");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    store.set("kbo-native-session-backup", "{not json");
    check("JSON 깨짐 → null", (await mod.readSessionBackup()) === null);
    store.set("kbo-native-session-backup", JSON.stringify({ access_token: "at-only" }));
    check("필드 누락 → null", (await mod.readSessionBackup()) === null);
  }

  console.log("[6] clear 후 read null");
  {
    const { bridge } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    await mod.clearSessionBackup();
    check("clear 후 null", (await mod.readSessionBackup()) === null);
  }

  console.log("[7] SecureSessionStore.get 영구 hang → 타임아웃 내 null (부팅 비차단)");
  {
    const { bridge } = makeBridge({ hangGet: true });
    setWindow(bridge);
    const t0 = Date.now();
    const read = await mod.readSessionBackup();
    const elapsed = Date.now() - t0;
    check("hang 시 null", read === null);
    check(`상한 내 반환 (${elapsed}ms)`, elapsed < 5000, `${elapsed}ms`);
  }

  console.log("[8] restore: 백업 없음 → null, setSession 미호출");
  {
    const { bridge } = makeBridge();
    setWindow(bridge);
    let called = 0;
    const auth = {
      setSession: async () => {
        called++;
        return { data: { session: { ok: true } }, error: null };
      },
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restored === null);
    check("setSession 0회", called === 0, `called=${called}`);
  }

  console.log("[9] restore: 성공 → 세션 반환 + 백업 보존");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const session = { user: { id: "u1" } };
    const auth = {
      setSession: async (t: { access_token: string; refresh_token: string }) => {
        check("백업 토큰 그대로 전달", t.access_token === "at-1" && t.refresh_token === "rt-1");
        return { data: { session }, error: null };
      },
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("복원 세션 반환", restored === session);
    check("백업 보존", store.size === 1);
  }

  console.log("[10] restore: 확정적 refresh 거부(code) → null + 백업 제거");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const auth = {
      setSession: async () => ({
        data: { session: null },
        error: { message: "Invalid Refresh Token: Refresh Token Not Found", status: 400, code: "refresh_token_not_found" },
      }),
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restored === null);
    check("무효 백업 제거됨", store.size === 0, `size=${store.size}`);
  }

  console.log("[11] restore: retryable 네트워크 error 반환 → null + 백업 보존 (삼순 P0)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    // supabase-js 는 일시적 네트워크 실패를 throw 가 아니라 error 로 반환한다
    const auth = {
      setSession: async () => ({
        data: { session: null },
        error: { message: "fetch failed", name: "AuthRetryableFetchError", status: 0 },
      }),
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restored === null);
    check("백업 보존 (retryable error)", store.size === 1, `size=${store.size}`);
  }

  console.log("[12] restore: 정체불명 error(코드·메시지 신호 없음) → 백업 보존 (fail-safe)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const auth = {
      setSession: async () => ({
        data: { session: null },
        error: { message: "Internal Server Error", status: 500 },
      }),
    };
    await mod.restoreSessionFromBackup(auth);
    check("백업 보존", store.size === 1, `size=${store.size}`);
  }

  console.log("[13] restore: transient throw → null + 백업 보존");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const auth = {
      setSession: async () => {
        throw new Error("network");
      },
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restored === null);
    check("백업 보존", store.size === 1, `size=${store.size}`);
  }

  console.log("[14] restore: setSession 영구 hang → 상한 내 null + 백업 보존 (삼순 P0)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const auth = {
      setSession: () => new Promise<never>(() => {}),
    };
    const t0 = Date.now();
    const restored = await mod.restoreSessionFromBackup(auth as any);
    const elapsed = Date.now() - t0;
    check("hang 시 null", restored === null);
    check(`상한 내 반환 (${elapsed}ms)`, elapsed < 5000, `${elapsed}ms`);
    check("백업 보존 (hang=transient)", store.size === 1, `size=${store.size}`);
  }

  console.log("[15] ladder: 쿠키 세션 존재 → 네이티브 read 0회 + 백업 갱신 (정상 로그인 무영향)");
  {
    const { bridge, calls, store } = makeBridge();
    setWindow(bridge);
    const cookieSession = { access_token: "at-c", refresh_token: "rt-c", user: { id: "u" } };
    let setSessionCalls = 0;
    const session = await mod.acquireSession({
      getCookieSession: async () => cookieSession,
      consumePendingTokens: () => {
        check("쿠키 세션 존재 시 pending 미소비", false, "consumePendingTokens 호출됨");
        return null;
      },
      setSession: async () => {
        setSessionCalls++;
        return { data: { session: null }, error: null };
      },
    });
    await settle();
    check("쿠키 세션 반환", session === cookieSession);
    check("setSession 0회", setSessionCalls === 0);
    const reads = calls.filter(c => c.method === "get").length;
    check("네이티브 read 0회", reads === 0, `reads=${reads}`);
    check("백업 갱신됨", store.size === 1);
  }

  console.log("[16] ladder: pending 토큰 존재 → setSession(pending), 네이티브 read 0회");
  {
    const { bridge, calls } = makeBridge();
    setWindow(bridge);
    const pendingSession = { access_token: "at-p2", refresh_token: "rt-p2", user: { id: "u" } };
    const session = await mod.acquireSession({
      getCookieSession: async () => null,
      consumePendingTokens: () => ({ access_token: "at-p", refresh_token: "rt-p" }),
      setSession: async (t: { access_token: string }) => {
        check("pending 토큰으로 setSession", t.access_token === "at-p");
        return { data: { session: pendingSession }, error: null };
      },
    });
    await settle();
    check("pending 세션 반환", session === pendingSession);
    const reads = calls.filter(c => c.method === "get").length;
    check("네이티브 read 0회", reads === 0, `reads=${reads}`);
  }

  console.log("[17] ladder: 쿠키·pending 모두 없음 → 백업 복원 경로 도달");
  {
    const { bridge, calls, store } = makeBridge();
    setWindow(bridge);
    store.set(
      "kbo-native-session-backup",
      JSON.stringify({ access_token: "at-b", refresh_token: "rt-b" }),
    );
    const restoredSession = { access_token: "at-b3", refresh_token: "rt-b3", user: { id: "u" } };
    const session = await mod.acquireSession({
      getCookieSession: async () => null,
      consumePendingTokens: () => null,
      setSession: async (t: { access_token: string }) => {
        check("백업 토큰으로 setSession", t.access_token === "at-b");
        return { data: { session: restoredSession }, error: null };
      },
    });
    await settle();
    check("복원 세션 반환", session === restoredSession);
    const reads = calls.filter(c => c.method === "get").length;
    check("네이티브 read 1회", reads === 1, `reads=${reads}`);
  }

  console.log("[18] ladder: getCookieSession throw → 하위 단계로 진행 (기존 semantics)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    store.set(
      "kbo-native-session-backup",
      JSON.stringify({ access_token: "at-b2", refresh_token: "rt-b2" }),
    );
    const restoredSession = { access_token: "at-b4", refresh_token: "rt-b4", user: { id: "u" } };
    const session = await mod.acquireSession({
      getCookieSession: async () => {
        throw new Error("getSession hang/fail");
      },
      consumePendingTokens: () => null,
      setSession: async () => ({ data: { session: restoredSession }, error: null }),
    });
    await settle();
    check("복원 세션 반환", session === restoredSession);
  }

  console.log("[19] 로그아웃 fence: fence 후 backup 시도는 no-op, 재삭제 후 빈 상태 유지 (삼순 P1)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    mod._resetLogoutFenceForTest();
    await mod.backupSessionTokens(tokens);
    check("사전 백업 존재", store.size === 1);
    // signOut 시작: fence → clear
    mod.beginLogoutFence();
    await mod.clearSessionBackup();
    // 동시 도착한 늦은 TOKEN_REFRESHED/SIGNED_IN 의 백업 시도
    await mod.backupSessionTokens({ access_token: "at-late", refresh_token: "rt-late" });
    check("fence 중 백업 차단", store.size === 0, `size=${store.size}`);
    // signOut 마지막 재삭제 (race 로 끼어든 기록 방어)
    await mod.clearSessionBackup();
    check("최종 빈 상태", store.size === 0);
    mod._resetLogoutFenceForTest();
  }

  console.log("[21] single-flight: 동시 acquireSession 2회 → 복원 1회만 실행·결과 공유 (삼순 2차 ①)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    mod._resetAcquireSessionForTest();
    store.set(
      "kbo-native-session-backup",
      JSON.stringify({ access_token: "at-sf", refresh_token: "rt-sf" }),
    );
    let cookieCalls = 0;
    let setSessionCalls = 0;
    const restoredSession = { access_token: "at-sf2", refresh_token: "rt-sf2", user: { id: "u" } };
    const deps = {
      getCookieSession: async () => {
        cookieCalls++;
        await new Promise(r => setTimeout(r, 50)); // mount·visibility 겹침 재현 창
        return null;
      },
      consumePendingTokens: () => null,
      setSession: async () => {
        setSessionCalls++;
        return { data: { session: restoredSession }, error: null };
      },
    };
    const [s1, s2] = await Promise.all([mod.acquireSession(deps), mod.acquireSession(deps)]);
    await settle();
    check("두 호출 동일 세션", s1 === restoredSession && s2 === restoredSession);
    check("쿠키 조회 1회", cookieCalls === 1, `cookieCalls=${cookieCalls}`);
    check("setSession 1회 (토큰 2회 재생 없음)", setSessionCalls === 1, `setSessionCalls=${setSessionCalls}`);
    // 완료 후 새 호출은 새 실행 (영구 캐시 아님)
    const s3 = await mod.acquireSession(deps);
    await settle();
    check("완료 후 새 실행", cookieCalls === 2 && s3 === restoredSession, `cookieCalls=${cookieCalls}`);
  }

  console.log("[22] CAS 삭제: 늦은 확정 거부가 그사이 갱신된 새 백업을 못 지운다 (삼순 2차 ①)");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    store.set(
      "kbo-native-session-backup",
      JSON.stringify({ access_token: "at-old", refresh_token: "rt-old" }),
    );
    const rotated = JSON.stringify({ access_token: "at-new", refresh_token: "rt-new" });
    const auth = {
      setSession: async () => {
        // 이 복원이 실패로 돌아오기 전, 다른 경로가 새 토큰으로 백업을 갱신함
        store.set("kbo-native-session-backup", rotated);
        return {
          data: { session: null },
          error: { message: "Invalid Refresh Token: Already Used", status: 400, code: "refresh_token_already_used" },
        };
      },
    };
    const restoredResult = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restoredResult === null);
    check("갱신된 백업 보존 (CAS)", store.get("kbo-native-session-backup") === rotated);
  }

  console.log("[20] isDefinitiveRefreshRejection 분류 경계");
  {
    const f = mod.isDefinitiveRefreshRejection;
    check("retryable name → false", f({ name: "AuthRetryableFetchError", message: "Invalid Refresh Token" }) === false);
    check("refresh_token_not_found → true", f({ code: "refresh_token_not_found" }) === true);
    check("refresh_token_already_used → true", f({ code: "refresh_token_already_used" }) === true);
    check("invalid_grant → true", f({ code: "invalid_grant" }) === true);
    check("메시지 신호 → true", f({ message: "Invalid Refresh Token: Already Used" }) === true);
    check("신호 없는 500 → false", f({ message: "Internal Server Error", status: 500 }) === false);
    check("빈 에러 → false", f({}) === false);
  }

  console.log("");
  if (failures > 0) {
    console.error(`FAIL — ${failures}건`);
    process.exit(1);
  }
  console.log("PASS — 전 케이스 통과");
}

main().catch(err => {
  console.error("smoke 실행 실패:", err);
  process.exit(1);
});
