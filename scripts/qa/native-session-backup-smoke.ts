/**
 * native-session-backup-smoke — 네이티브 세션 백업/복구 모듈 행위 검증.
 *
 * 대상: src/lib/capacitor/session-backup.ts
 * 실행: npm run qa:native-session-backup
 *
 * 각 케이스는 해당 안전 계약이 깨지면 그 자리에서 FAIL 을 낸다 (행위 기반 —
 * 소스 문면 매칭 없음). 주입 브릿지(window.Capacitor)를 케이스별로 갈아끼우며
 * 웹/구버전 바이너리 no-op, 왕복, 손상 데이터, 복원 의미론, hang 상한을 검증한다.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

type PrefsCall = { method: string; key: string; value?: string };

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
  calls?: PrefsCall[];
  hangGet?: boolean;
  omitPlugin?: boolean;
}) {
  const store = opts?.store ?? new Map<string, string>();
  const calls = opts?.calls ?? [];
  const Preferences = {
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
      Plugins: opts?.omitPlugin ? {} : { Preferences },
    },
    store,
    calls,
  };
}

function setWindow(bridge: unknown) {
  (globalThis as any).window = bridge === null ? undefined : { Capacitor: bridge };
  if (bridge === null) delete (globalThis as any).window;
}

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

  console.log("[2] 구버전 바이너리(네이티브인데 Preferences 플러그인 없음) — no-op");
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
    await mod.backupSessionTokens({ access_token: "", refresh_token: "rt" });
    await mod.backupSessionTokens({ access_token: "at", refresh_token: "" } as any);
    check("기록 0건", store.size === 0, `size=${store.size}`);
  }

  console.log("[5] 손상된 백업(JSON 깨짐/필드 누락) → null");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    store.set("kbo-native-session-backup", "{not json");
    check("JSON 깨짐 → null", (await mod.readSessionBackup()) === null);
    store.set("kbo-native-session-backup", JSON.stringify({ access_token: "only" }));
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

  console.log("[7] Preferences.get 영구 hang → 타임아웃 내 null (부팅 비차단)");
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

  console.log("[10] restore: 무효 refresh(error 반환) → null + 백업 제거");
  {
    const { bridge, store } = makeBridge();
    setWindow(bridge);
    await mod.backupSessionTokens(tokens);
    const auth = {
      setSession: async () => ({
        data: { session: null },
        error: { message: "Invalid Refresh Token" },
      }),
    };
    const restored = await mod.restoreSessionFromBackup(auth);
    check("null 반환", restored === null);
    check("무효 백업 제거됨", store.size === 0, `size=${store.size}`);
  }

  console.log("[11] restore: transient throw → null + 백업 보존 (다음 부팅 재시도)");
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
