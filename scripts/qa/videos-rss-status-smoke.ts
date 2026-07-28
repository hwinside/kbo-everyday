/**
 * videos-rss job status 판정 회귀 스모크.
 *
 * fail-closed 결함(삼순 NO-GO) 재발 방지:
 *   전 채널 RSS 실패 + fallback 전부 noUploads → coreFailedCount=0 이지만 okCount=0.
 *   과거 로직은 이 전멸 상황을 success/ok=true 로 표시했다. 이제 okCount===0 은 error.
 *
 * 실행: npm run qa:videos-rss-status
 */
import { classifyVideosRssStatus } from "../../src/lib/video/videos-rss-status";

let pass = 0;
let fail = 0;

function check(
  name: string,
  input: { okCount: number; coreFailedCount: number; ledgerErr: boolean },
  expected: "success" | "warning" | "error",
) {
  const got = classifyVideosRssStatus(input);
  if (got === expected) {
    pass++;
    console.log(`  ✅ ${name} → ${got}`);
  } else {
    fail++;
    console.log(`  ❌ ${name} — expected ${expected}, got ${got}`);
  }
}

console.log("videos-rss status classification smoke");

// ① bulk 성공(394 ok) + dead 채널 1건(noUploads → coreFailed 제외) → success 유지
check("bulk 성공 + dead 1건(noUploads)", { okCount: 394, coreFailedCount: 0, ledgerErr: false }, "success");

// ② 전 채널 실패(okCount=0) → error (전멸)
//    - 전부 noUploads(coreFailed=0)여도 전멸이면 error (핵심 회귀)
check("전멸: 전채널 RSS실패+fallback noUploads (coreFailed=0)", { okCount: 0, coreFailedCount: 0, ledgerErr: false }, "error");
//    - 전부 실제 실패(coreFailed>0)도 error
check("전멸: 전채널 core 실패 (coreFailed>0)", { okCount: 0, coreFailedCount: 40, ledgerErr: false }, "error");

// ③ core 부분실패 다수 (okCount>0) → warning
check("부분실패 다수 (okCount>0, coreFailed>0)", { okCount: 390, coreFailedCount: 4, ledgerErr: false }, "warning");

// 보강: 원장 RPC 장애만 있으면(core 정상) warning
check("원장 장애만 (coreFailed=0, ledgerErr)", { okCount: 400, coreFailedCount: 0, ledgerErr: true }, "warning");
// 보강: 완전 정상 → success
check("완전 정상 (coreFailed=0, ledger OK)", { okCount: 400, coreFailedCount: 0, ledgerErr: false }, "success");

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log("✓ ALL PASS — videos-rss status 판정 OK");
