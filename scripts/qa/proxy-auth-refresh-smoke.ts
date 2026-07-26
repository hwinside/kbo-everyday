import { readFileSync } from "node:fs";
import type { NextRequest } from "next/server";
import { isTopLevelDocumentNavigation } from "../../src/proxy";

let pass = 0;
let fail = 0;

function check(name: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    console.error("  ✗", name);
  }
}

// --- Source contract: refresh is gated behind a top-level document check ---
const proxySource = readFileSync("src/proxy.ts", "utf8");

check(
  "public(무쿠키) 요청은 서버 갱신 없이 통과",
  /hasAuthCookie[\s\S]*?return NextResponse\.next/.test(proxySource),
);
check(
  "RSC/prefetch 는 top-level 게이트로 서버 갱신을 건너뜀",
  proxySource.includes("if (!isTopLevelDocumentNavigation(request))"),
);
check(
  "만료 임박 세션 갱신 경로(getClaims)는 유지",
  proxySource.includes("supabase.auth.getClaims()"),
);
check(
  "top-level 게이트가 getClaims 호출 앞에서 RSC/prefetch를 차단",
  proxySource.indexOf("if (!isTopLevelDocumentNavigation(request))") <
    proxySource.indexOf("supabase.auth.getClaims()"),
);

// --- Unit: header classification (the real logic, not just a static string) ---
function mkReq(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

check(
  "실제 문서 네비게이션(sec-fetch-dest: document)은 갱신 대상",
  isTopLevelDocumentNavigation(
    mkReq({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }),
  ) === true,
);
check(
  "RSC 요청은 갱신 제외",
  isTopLevelDocumentNavigation(mkReq({ rsc: "1", "sec-fetch-dest": "empty" })) ===
    false,
);
check(
  "라우터 prefetch 는 갱신 제외",
  isTopLevelDocumentNavigation(
    mkReq({ "next-router-prefetch": "1", "sec-fetch-dest": "document" }),
  ) === false,
);
check(
  "sec-fetch-dest: empty(RSC fetch)는 갱신 제외",
  isTopLevelDocumentNavigation(mkReq({ "sec-fetch-dest": "empty" })) === false,
);
check(
  "sec-fetch 헤더 부재(구형 WebView)는 보수적으로 top-level 로 간주",
  isTopLevelDocumentNavigation(mkReq({})) === true,
);

console.log(`\nProxy auth refresh smoke: ${pass} PASS / ${fail} FAIL`);
if (fail > 0) process.exit(1);
