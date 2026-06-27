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
  parseAttribution,
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

// parseAttribution — appendAttribution 역연산(렌더러가 원문 하이퍼링크로 그릴 때 사용)
{
  const content = appendAttribution("구자욱과 이용찬의 신경전", IG_URL, IG_DESC_HTML);
  const p = parseAttribution(content);
  check("parse: IG roundtrip body", p?.body === "구자욱과 이용찬의 신경전", `got ${JSON.stringify(p)}`);
  check("parse: IG roundtrip source", p?.source === "인스타 @deliciousports", `got ${JSON.stringify(p)}`);
  check("parse: IG label/handle 분리", p?.label === "인스타" && p?.handle === "deliciousports", `got ${JSON.stringify(p)}`);
  check("parse: IG roundtrip url", p?.url === IG_URL, `got ${JSON.stringify(p)}`);
}
{
  const content = appendAttribution("좋은 영상", THREADS_URL, null);
  const p = parseAttribution(content);
  check("parse: 스레드 source", p?.source === "스레드 @chunkizzi_", `got ${JSON.stringify(p)}`);
  check("parse: 스레드 url", p?.url === THREADS_URL, `got ${JSON.stringify(p)}`);
}
{
  const content = appendAttribution("", IG_URL, IG_DESC_HTML);
  const p = parseAttribution(content);
  check("parse: 본문 없는 출처-only → body 빈 문자열", p?.body === "" && p?.url === IG_URL, `got ${JSON.stringify(p)}`);
}
{
  const p = parseAttribution("엠팍 짤" + `\n\n(출처: 엠팍)\n${MLBPARK_URL}`);
  check("parse: 핸들 없는 (출처: 엠팍) → label 엠팍 + handle null", p?.label === "엠팍" && p?.handle === null && p?.url === MLBPARK_URL, `got ${JSON.stringify(p)}`);
}
check("parse: 출처 블록 없으면 null", parseAttribution("그냥 본문") === null);
check("parse: URL 없는 수동 출처는 매치 안 함(링크 대상 없음)", parseAttribution("멋진 장면 (출처: 인스타 @x)") === null);
check("parse: 빈/누락 입력 → null", parseAttribution("") === null && parseAttribution(null) === null && parseAttribution(undefined) === null);

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
