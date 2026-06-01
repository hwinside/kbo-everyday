/**
 * 움짤콜렉터 출처 표기(attribution) 순수 함수 smoke test.
 *
 * Usage: npx tsx scripts/qa/gif-collector-attribution-smoke.ts
 */

import {
  getPlatformLabel,
  getThreadsHandle,
  extractInstagramHandle,
  resolveHandle,
  hasExistingAttribution,
  appendAttribution,
} from "@/lib/gif-collector/attribution";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    console.log(`✓ ${name}`);
    pass++;
  } else {
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ""}`);
    fail++;
  }
}

const IG_URL = "https://www.instagram.com/reel/DY_6Rodx3dL/?igsh=abc";
const THREADS_URL = "https://www.threads.com/@chunkizzi_/post/DZDMHy-kgtY?xmt=AQ";
const MLBPARK_URL = "https://mlbpark.donga.com/mp/b.php?id=202605310115718801";
const IG_DESC_HTML = `<meta property="og:description" content="7,579 likes, 427 comments - deliciousports on May 31, 2026: &quot;hi&quot;">`;

// getPlatformLabel
check("플랫폼 라벨: instagram → 인스타", getPlatformLabel(IG_URL) === "인스타");
check("플랫폼 라벨: threads → 스레드", getPlatformLabel(THREADS_URL) === "스레드");
check("플랫폼 라벨: mlbpark → 엠팍", getPlatformLabel(MLBPARK_URL) === "엠팍");
check("플랫폼 라벨: 미지 도메인 → host(www 제거)", getPlatformLabel("https://www.example.com/x") === "example.com");

// getThreadsHandle
check("Threads 핸들 URL 추출", getThreadsHandle(THREADS_URL) === "chunkizzi_", `got ${getThreadsHandle(THREADS_URL)}`);
check("Threads 아닌 URL → null", getThreadsHandle(IG_URL) === null);

// extractInstagramHandle
check(
  "IG og:description에서 핸들 추출",
  extractInstagramHandle(IG_DESC_HTML) === "deliciousports",
  `got ${extractInstagramHandle(IG_DESC_HTML)}`,
);
check("IG og:description 없으면 null", extractInstagramHandle("<html></html>") === null);

// resolveHandle
check("resolveHandle: threads는 URL로", resolveHandle(THREADS_URL, null) === "chunkizzi_");
check("resolveHandle: instagram은 html og:description으로", resolveHandle(IG_URL, IG_DESC_HTML) === "deliciousports");
check("resolveHandle: instagram html 없으면 null", resolveHandle(IG_URL, null) === null);
check("resolveHandle: mlbpark → null", resolveHandle(MLBPARK_URL, "<html></html>") === null);

// hasExistingAttribution
check("기존 '출처' 텍스트 있으면 중복 감지", hasExistingAttribution("멋진 장면 (출처: 인스타 @x)", IG_URL));
check("기존 원문 URL 있으면 중복 감지", hasExistingAttribution(`보세요 ${IG_URL}`, IG_URL));
check("트래킹 파라미터 달라도 경로 같으면 중복 감지", hasExistingAttribution("보세요 www.instagram.com/reel/DY_6Rodx3dL", IG_URL));
check("출처/URL 없으면 중복 아님", hasExistingAttribution("그냥 본문", IG_URL) === false);

// appendAttribution
{
  const r = appendAttribution("구자욱과 이용찬의 신경전", IG_URL, IG_DESC_HTML);
  check(
    "IG: 깨끗한 본문에 (출처: 인스타 @handle) + URL append",
    r === `구자욱과 이용찬의 신경전\n\n(출처: 인스타 @deliciousports)\n${IG_URL}`,
    `got ${JSON.stringify(r)}`,
  );
}
{
  const r = appendAttribution("멋진 장면 (출처: 인스타 @deliciousports)", IG_URL, IG_DESC_HTML);
  check("이미 출처 있으면 그대로(중복 append 안 함)", r === "멋진 장면 (출처: 인스타 @deliciousports)", `got ${JSON.stringify(r)}`);
}
{
  const r = appendAttribution("", IG_URL, IG_DESC_HTML);
  check("빈 본문이면 출처 줄만", r === `(출처: 인스타 @deliciousports)\n${IG_URL}`, `got ${JSON.stringify(r)}`);
}
{
  const r = appendAttribution("좋은 영상", THREADS_URL, null);
  check(
    "Threads: 핸들 URL에서 + append",
    r === `좋은 영상\n\n(출처: 스레드 @chunkizzi_)\n${THREADS_URL}`,
    `got ${JSON.stringify(r)}`,
  );
}
{
  const r = appendAttribution("엠팍 짤", MLBPARK_URL, "<html></html>");
  check(
    "MLBPARK: 핸들 없으면 (출처: 엠팍) + URL",
    r === `엠팍 짤\n\n(출처: 엠팍)\n${MLBPARK_URL}`,
    `got ${JSON.stringify(r)}`,
  );
}
{
  const r = appendAttribution("핸들 못찾는 인스타", IG_URL, "<html></html>");
  check(
    "IG 핸들 추출 실패 시 (출처: 인스타) only",
    r === `핸들 못찾는 인스타\n\n(출처: 인스타)\n${IG_URL}`,
    `got ${JSON.stringify(r)}`,
  );
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
