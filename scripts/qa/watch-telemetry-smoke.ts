/**
 * 워치 앱 사용 계측 UA 분류 회귀 스모크 (npm run qa:watch-telemetry)
 * proxy(구 middleware)의 classifyWatchPlatform 순수 함수로
 *   일반 UA = 계측 0회 / Wear UA = 'wear' 1회 / Apple UA = 'apple' 1회
 * 를 실제 모듈로 검증한다. (삼순 재리뷰 조건 c)
 */
import { classifyWatchPlatform } from "@/proxy";

let pass = 0,
  fail = 0;
const ck = (n: string, c: boolean) => {
  if (c) {
    pass++;
    console.log("  ✓", n);
  } else {
    fail++;
    console.error("  ✗", n);
  }
};

const WEAR = "kbo-everyday-wear/1.0";
const APPLE = "kbo-everyday-watch/1.0";
const BROWSER =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15";
const APP = "kbo-everyday/1.0.13"; // 폰 네이티브 앱(계측 대상 아님)

// 1) /api/standings + 각 UA → 정확한 platform 1회
ck("standings + Wear UA → 'wear'", classifyWatchPlatform("/api/standings", WEAR) === "wear");
ck("standings + Apple UA → 'apple'", classifyWatchPlatform("/api/standings", APPLE) === "apple");

// 2) /api/standings + 계측 대상 아닌 UA → null (RPC 0회)
ck("standings + 브라우저 UA → null", classifyWatchPlatform("/api/standings", BROWSER) === null);
ck("standings + 폰앱 UA → null", classifyWatchPlatform("/api/standings", APP) === null);
ck("standings + 빈 UA → null", classifyWatchPlatform("/api/standings", "") === null);

// 3) 다른 경로는 워치 UA여도 계측 안 함 (중복 카운트 방지 — standings 만 매 동기화 1회)
ck("games + Wear UA → null(경로 불일치)", classifyWatchPlatform("/api/games", WEAR) === null);
ck("standings 하위경로 → null", classifyWatchPlatform("/api/standings/2026", WEAR) === null);
ck("루트 + Wear UA → null", classifyWatchPlatform("/", WEAR) === null);

// 4) wear vs watch substring 오분류 없음 (wear ⊄ watch, watch ⊄ wear)
ck("Wear UA가 apple로 오분류 안 됨", classifyWatchPlatform("/api/standings", WEAR) !== "apple");
ck("Apple UA가 wear로 오분류 안 됨", classifyWatchPlatform("/api/standings", APPLE) !== "wear");

// 5) UA 안에 두 토큰이 다 있으면 wear 우선(결정적) — 실제로는 발생 안 하지만 순서 고정 회귀
ck(
  "wear+watch 동시 포함 → wear 우선(결정적)",
  classifyWatchPlatform("/api/standings", `${WEAR} ${APPLE}`) === "wear",
);

console.log(`\n워치 계측 UA 분류 스모크: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
