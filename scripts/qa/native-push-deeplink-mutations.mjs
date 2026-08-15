#!/usr/bin/env node
/**
 * native-push-deeplink 게이트 검증력 증명 — 결함 주입 mutation.
 *
 * 각 mutation은 "이 결함이 들어가면 게이트가 반드시 RED"를 증명한다.
 * 앵커가 사라지면(리팩터링) MISS로 실패시켜, 게이트가 조용히 무력화되는 것을 막는다.
 * 원본은 항상 복원한다(finally).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEEPLINK = path.join(root, "src/lib/native-push-deeplink.ts");
const MOUNT = path.join(root, "src/components/NativePushMount.tsx");
const APPDELEGATE = path.join(root, "ios/App/App/AppDelegate.swift");
const PLUGIN = path.join(root, "ios/App/App/PushDeepLinkPlugin.swift");
const LA_WIDGET = path.join(root, "ios/App/LiveActivity/KBOLiveActivityWidget.swift");
const DISPATCHER = path.join(root, "src/lib/capacitor/app-url-open.ts");

const mutations = [
  {
    id: "M1 background 탭 즉시 이동(앱 상태 무시)",
    file: DEEPLINK,
    from: `      void app.getState().then(({ isActive }) => {
        if (isActive) consumePendingTap();
      }).catch(() => undefined);`,
    to: `      consumePendingTap();`,
  },
  {
    id: "M2 appStateChange active 소비 제거(#1070 경로 파괴)",
    file: DEEPLINK,
    from: "    if (!isActive) return;",
    to: "    return;",
  },
  {
    id: "M3 cold-start 네이티브 stash 회수 제거(#1198 경로 파괴)",
    file: DEEPLINK,
    from: "  await consumeNativePendingIntoStore(loaders);",
    to: "  // mutation: cold-start stash 회수 제거",
  },
  {
    id: "M4 중복 이동 가드 제거(cold+retained 이중 이동)",
    file: DEEPLINK,
    from: "  if (lastConsumedUrl === pending.url && now - lastConsumedAt <= DUPLICATE_NAV_WINDOW_MS) return;",
    to: "  // mutation: 중복 가드 제거",
  },
  {
    id: "M5 TTL 검사 제거(만료 pending도 이동)",
    file: DEEPLINK,
    from: "    if (!url || typeof parsed.createdAt !== \"number\" || now - parsed.createdAt > PENDING_TAP_TTL_MS) {",
    to: "    if (!url) {",
  },
  {
    id: "M6 1회 소비 파괴(pending 미제거 → 재활성화마다 이동)",
    file: DEEPLINK,
    from: `  window.localStorage.removeItem(PENDING_TAP_KEY);
  const now = Date.now();`,
    to: "  const now = Date.now();",
  },
  {
    id: "M7 URL 가드 무력화(외부·protocol-relative 허용)",
    file: DEEPLINK,
    from: `  if (typeof window === "undefined" || typeof url !== "string" || !url.startsWith("/")) return null;`,
    to: `  if (typeof window === "undefined" || typeof url !== "string") return url as string;`,
  },
  {
    id: "M8 구빌드 안전망 파괴(플러그인 없으면 전체 attach 실패)",
    file: DEEPLINK,
    from: `  } catch {
    // 구빌드(플러그인 미탑재)/브릿지 오류 — 딥링크는 부가 기능, 앱 동작 무영향
  }`,
    to: `  } catch (e) {
    throw e;
  }`,
  },
  {
    id: "M9 mount가 정적 gate 뒤로 이동(원격로드 오판 회귀)",
    file: MOUNT,
    from: `    void listenForNotificationTap();
    if (!isNativeRuntime()) return;`,
    to: `    if (!isNativeRuntime()) return;
    void listenForNotificationTap();`,
  },
  {
    id: "M10 AppDelegate silent(.background) launch 제외 해제",
    file: APPDELEGATE,
    from: "        if application.applicationState != .background,",
    to: "        if true,",
  },
  {
    id: "M11 네이티브 consume 1회 소비 파괴(키 미삭제)",
    file: PLUGIN,
    from: "        defaults.removeObject(forKey: Self.urlKey)",
    to: "        // mutation: 키 미삭제",
  },
  {
    id: "M12 네이티브 stash 경로 가드 제거",
    file: PLUGIN,
    from: `        guard url.hasPrefix("/"), !url.hasPrefix("//") else { return }`,
    to: "        // mutation: stash 가드 제거",
  },
  {
    id: "M13 actual loader가 주입 브릿지 무시(npm core=Web 구현에 부착)",
    file: DEEPLINK,
    from: `    const injected = injectedPlugin<MessagingSource>("FirebaseMessaging");
    if (injected) {
      return { addListener: (event, listener) => injected.addListener(event, listener) };
    }`,
    to: "",
  },
  {
    id: "M14 actual App loader가 주입 브릿지 무시",
    file: DEEPLINK,
    from: `    const injected = injectedPlugin<AppStateSource>("App");
    if (injected) {
      return {
        getState: () => injected.getState(),
        addListener: (event, listener) => injected.addListener(event, listener),
      };
    }`,
    to: "",
  },
  {
    id: "M15 mount 중복 호출 재도입",
    file: MOUNT,
    from: "    void listenForForegroundNotifications();",
    to: "    void listenForForegroundNotifications();\n    void listenForNotificationTap();",
  },
  {
    id: "M16 warm 복귀 시 네이티브 stash 재회수 제거(LA 카드 warm 탭 회귀)",
    file: DEEPLINK,
    from: "    void consumeNativePendingIntoStore(loaders).then(() => consumePendingTap());",
    to: "    consumePendingTap();",
  },
  {
    id: "M17 잠금카드 widgetURL 제거(LA 탭 딥링크 소멸)",
    file: LA_WIDGET,
    from: `                .widgetURL(gameDeepLinkURL(context.attributes.gameId))
        } dynamicIsland: { context in`,
    to: `        } dynamicIsland: { context in`,
  },
  {
    id: "M18 continue의 /games/<id> 폐쇄 allowlist 완화(임의 경로·auth 우회 허용)",
    file: APPDELEGATE,
    from: `        guard path.range(of: "^/games/[A-Za-z0-9]{1,32}$", options: .regularExpression) != nil else { return }`,
    to: `        guard path.hasPrefix("/") else { return }`,
  },
  {
    id: "M19 appUrlOpen 재회수 제거(순서 역전 시 pending 영구 잔류)",
    file: DEEPLINK,
    from: `    void consumeNativePendingIntoStore(loaders)
      .then(() => app.getState())
      .then(({ isActive }) => {
        if (isActive) consumePendingTap();
      })
      .catch(() => undefined);
  });`,
    to: `  await loaders.urlOpen(() => {});`,
  },
  {
    id: "M20 gameId allowlist 완화(위젯 URL에 임의 문자열 허용)",
    file: LA_WIDGET,
    from: `    guard gameId.range(of: "^[A-Za-z0-9]{1,32}$", options: .regularExpression) != nil else { return nil }`,
    to: `    guard !gameId.isEmpty else { return nil }`,
  },
  {
    id: "M21 디스패처 replay 제거(late OAuth subscriber가 retained 이벤트 유실)",
    file: DISPATCHER,
    from: `  for (const buffered of [...replayBuffer]) deliver(consumerId, subscriber, buffered);`,
    to: "",
  },
  {
    id: "M22 딥링크가 App.addListener('appUrlOpen') 직접 등록 재도입(OAuth 경합 회귀)",
    file: DEEPLINK,
    from: `  urlOpen: (listener) => subscribeAppUrlOpen("la-deeplink", listener),`,
    to: `  urlOpen: async (listener) => {
    const { App } = await import("@capacitor/app");
    await App.addListener("appUrlOpen", listener);
  },`,
  },
  {
    id: "M23 R4 orphan expiry timer 무력화(secret URL 무기한 잔류)",
    file: DISPATCHER,
    from: `    expiryTimer: setTimeout(() => dropBuffered(buffered), orphanTtlMs),`,
    to: `    expiryTimer: setTimeout(() => undefined, orphanTtlMs),`,
  },
  {
    id: "M24 R4 소비자별 1회·수신 즉시 삭제 가드 제거(secret 중복 재생·잔류)",
    file: DISPATCHER,
    from: `  if (!buffered.pending.has(consumerId)) return; // 소비자별 1회 — 재구독/재마운트 중복 재생 0
  buffered.pending.delete(consumerId);
  if (buffered.pending.size === 0) dropBuffered(buffered); // 마지막 대기 소비자 수신 → secret 즉시 폐기(R4)`,
    to: "",
  },
  {
    id: "M25 R3-① attach 실패 자체 재시도 제거(영구 무수신 재발)",
    file: DISPATCHER,
    from: `      attachPromise = null;
      scheduleRetry(); // 실패를 삼키되 재연결 책임은 디스패처가 진다(R3-①)`,
    to: `      attachPromise = null;`,
  },
  {
    id: "M26 R5 폐쇄 분류 무력화(모든 URL을 양 소비자 pending — secret 잔류·무관 전달 회귀)",
    file: DISPATCHER,
    from: `  const relevant = classifyAppUrlOpen(event.url);
  if (relevant === null) return; // unknown — replay 없이 fail-closed(보관 0·전달 0)`,
    to: `  const relevant = "oauth";`,
  },
  {
    id: "M27 R5 unknown fail-closed 제거(분류 불가 URL을 oauth로 fail-open)",
    file: DISPATCHER,
    from: `  if (LA_GAMES_PATH_RE.test(parsed.pathname)) return "la-deeplink";
  return null;`,
    to: `  if (LA_GAMES_PATH_RE.test(parsed.pathname)) return "la-deeplink";
  return "oauth";`,
  },
  {
    id: "M28 R6 서버 오류 callback 키 인식 제거(auth_error URL 폐기 → 네이티브 오류 안내 소실)",
    file: DISPATCHER,
    from: `  for (const key of AUTH_ERROR_PARAM_KEYS) {
    if (parsed.searchParams.has(key) || hashParams.has(key)) return "oauth";
  }`,
    to: "",
  },
  {
    id: "M29 R6 /auth exact segment 판정 완화(startsWith 회귀 — /author 오분류)",
    file: DISPATCHER,
    from: `  if (parsed.pathname === "/auth" || parsed.pathname.startsWith("/auth/")) return "oauth";`,
    to: `  if (parsed.pathname.startsWith("/auth")) return "oauth";`,
  },
  {
    id: "M30 open(url:) 경로 이벤트 URL 직접 소비 제거(stash 없는 widgetURL 미이동 재발)",
    file: DEEPLINK,
    from: `    const direct = laDeepLinkPathFromEvent(event);
    if (direct) storePendingTap(direct);`,
    to: "",
  },
  {
    id: "M31 이벤트 URL 폐쇄 분류 무력화(OAuth callback 까지 딥링크 pending 저장)",
    file: DEEPLINK,
    from: `  if (classifyAppUrlOpen(url) !== "la-deeplink") return null;`,
    to: "",
  },
  {
    id: "M32 AppDelegate open(url:) stash 제거(continue 로 안 오는 경로 미커버 재발)",
    file: APPDELEGATE,
    from: `        stashLiveActivityDeepLinkIfAllowed(url)
        let facebookHandled`,
    to: `        let facebookHandled`,
  },
];

function runGate() {
  const res = spawnSync("npx", ["tsx", "--test", "scripts/qa/native-push-deeplink-smoke.ts"], {
    cwd: root,
    encoding: "utf8",
  });
  return res.status === 0;
}

let failures = 0;
console.log("baseline 확인…");
if (!runGate()) {
  console.error("✖ baseline이 이미 RED — mutation 판정 불가");
  process.exit(1);
}
console.log("✔ baseline GREEN\n");

for (const m of mutations) {
  const original = readFileSync(m.file, "utf8");
  const occurrences = original.split(m.from).length - 1;
  if (occurrences !== 1) {
    console.error(`✖ ${m.id} — 앵커 MISS (found ${occurrences}, expected 1) in ${path.relative(root, m.file)}`);
    failures += 1;
    continue;
  }
  try {
    writeFileSync(m.file, original.replace(m.from, m.to));
    const green = runGate();
    if (green) {
      console.error(`✖ ${m.id} — 결함 주입에도 게이트 GREEN (검출력 없음)`);
      failures += 1;
    } else {
      console.log(`✔ ${m.id} — RED`);
    }
  } finally {
    writeFileSync(m.file, original);
  }
}

console.log(`\n${mutations.length - failures}/${mutations.length} RED`);
if (failures > 0) process.exit(1);
console.log("게이트 검증력 확인 완료");
