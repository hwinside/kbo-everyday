/**
 * 조건부 응답(ETag / If-None-Match → 304) 헬퍼 스모크.
 * 실시간 손실 0(폴링 주기 불변) + 변경 감지 정확성을 회귀로 고정한다.
 *
 * 실행: npx tsx scripts/qa/conditional-etag-smoke.ts
 */
import {
  computeStrongETag,
  ifNoneMatchSatisfied,
  jsonWithETag,
} from "../../src/lib/http/conditional";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; }
  else { fail++; console.error(`  ✗ ${name}`); }
}

function req(headers?: Record<string, string>): Request {
  return new Request("https://x.test/api/game-detail?gameId=20260728WOLG0", { headers });
}

const bodyOf = (p: unknown) => JSON.stringify(p);

async function run() {
  // --- 해시/ETag 결정성 ---
  check("computeStrongETag 결정적(동일 입력 동일 해시)", (await computeStrongETag("abc")) === (await computeStrongETag("abc")));
  check("computeStrongETag 상이 입력 상이 해시", (await computeStrongETag("abc")) !== (await computeStrongETag("abd")));
  check(
    "computeStrongETag 형식 W/\"len-sha256(64hex)\"",
    /^W\/"[0-9a-f]+-[0-9a-f]{64}"$/.test(await computeStrongETag(bodyOf({ a: 1 }))),
  );

  const p1 = { gameId: "g", score: [3, 5], innings: 9 };
  const p1b = { gameId: "g", score: [3, 5], innings: 9 };
  const p2 = { gameId: "g", score: [3, 6], innings: 9 };
  const et = await computeStrongETag(bodyOf(p1));
  const etP2 = await computeStrongETag(bodyOf(p2));
  check("동일 payload → 동일 ETag", et === (await computeStrongETag(bodyOf(p1b))));
  check("변경 payload → 상이 ETag", et !== etP2);

  // --- 삼순 P1: FNV-1a 32-bit+길이 충돌쌍 → SHA-256은 구분해야 한다 ---
  // 아래 두 payload 는 서로 다르고 길이 동일(43)이며 구 FNV-1a+길이 ETag 가 둘 다
  // `W/"2b-6a5e9d5b"` 로 충돌했다(brute-force 로 찾은 실제 쌍). 구 방식이면 old
  // If-None-Match + 변경 payload 가 304 빈바디로 오판돼 변경 데이터가 유실된다.
  const collA = { gameId: "20260728WOLG0", tag: "000198eb" };
  const collB = { gameId: "20260728WOLG0", tag: "00052938" };
  check("known collision pair: 서로 다른 payload", bodyOf(collA) !== bodyOf(collB));
  check("known collision pair: 길이 동일(구 방식 충돌 조건)", bodyOf(collA).length === bodyOf(collB).length);
  const etCollA = await computeStrongETag(bodyOf(collA));
  const etCollB = await computeStrongETag(bodyOf(collB));
  check("SHA-256은 충돌쌍을 상이 ETag로 구분", etCollA !== etCollB);
  // 핵심 회귀: 클라가 collA 의 ETag 를 들고 있고 데이터가 collB 로 바뀌면 → 반드시 200(새 바디),
  // 절대 304 오판이 아니어야 한다.
  const collChanged = await jsonWithETag(req({ "if-none-match": etCollA }), collB);
  check("충돌쌍 변경 재요청 → 200(304 오판 아님)", collChanged.status === 200);
  const collChangedBody = await collChanged.json();
  check("충돌쌍 변경 응답 새 바디(collB)", collChangedBody.tag === "00052938");
  check("충돌쌍 변경 응답 새 ETag(=collB)", collChanged.headers.get("ETag") === etCollB);

  // --- If-None-Match 판정 ---
  check("If-None-Match 매치 → true", ifNoneMatchSatisfied(et, et));
  check("If-None-Match 불일치 → false", ifNoneMatchSatisfied(etP2, et) === false);
  check("If-None-Match 없음 → false", ifNoneMatchSatisfied(null, et) === false);
  check("If-None-Match '*' → true", ifNoneMatchSatisfied("*", et) === true);
  check("If-None-Match 다중 값 중 매치 → true", ifNoneMatchSatisfied(`W/"deadbeef", ${et}`, et) === true);
  check("weak/strong 혼용 비교(W/ 제거 후 동일)", ifNoneMatchSatisfied(et.replace(/^W\//, ""), et) === true);

  // --- jsonWithETag: 첫 요청(200 + ETag + no-cache) ---
  const first = await jsonWithETag(req(), p1);
  check("첫 요청 status 200", first.status === 200);
  const firstETag = first.headers.get("ETag");
  check("첫 요청 ETag 세팅", firstETag === et);
  check("첫 요청 Cache-Control private no-cache", (first.headers.get("Cache-Control") || "").includes("no-cache"));
  const body = await first.json();
  check("첫 요청 바디 정상 반환", body.score[1] === 5);

  // --- 재폴링: 동일 데이터 + If-None-Match → 304 빈 바디 ---
  const notMod = await jsonWithETag(req({ "if-none-match": firstETag! }), p1);
  check("동일 데이터 재요청 → 304", notMod.status === 304);
  check("304 ETag 유지", notMod.headers.get("ETag") === et);
  check("304 Cache-Control 유지", (notMod.headers.get("Cache-Control") || "").includes("no-cache"));
  const notModText = await notMod.text();
  check("304 바디 비어있음(전송 0)", notModText === "");

  // --- 데이터 변경 시: 같은 If-None-Match라도 200 + 새 바디 ---
  const changed = await jsonWithETag(req({ "if-none-match": firstETag! }), p2);
  check("데이터 변경 재요청 → 200(304 아님)", changed.status === 200);
  check("변경 응답 새 ETag", changed.headers.get("ETag") === etP2);
  const changedBody = await changed.json();
  check("변경 응답 새 바디", changedBody.score[1] === 6);

  // --- 단일 직렬화: ETag 해시 바디와 전송 바디가 정확히 일치(드리프트 0) ---
  const serialized = await jsonWithETag(req(), p1);
  check("전송 바디 == 단일 직렬화 문자열", (await serialized.text()) === bodyOf(p1));

  // --- 실시간성 보존: 매 폴링마다 판정하므로 변경은 즉시 200 반영(지연 0) ---
  // (동일→304, 변경→즉시 200) 위 케이스가 지연 0을 함께 증명.

  // --- 에러/비200 status는 조건부 304 미적용(안전) ---
  const errResp = await jsonWithETag(req({ "if-none-match": firstETag! }), p1, { status: 500 });
  check("비200 status는 304로 강등 안 함", errResp.status === 500);

  console.log(`\nconditional-etag: ${pass}/${pass + fail} pass${fail ? `, ${fail} FAIL` : ""}`);
  if (fail) process.exit(1);
}

run();
