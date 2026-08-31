/**
 * A0 shadow replay 용 env preload.
 *
 * ⚠️ 왜 별도 파일인가: `.env.local` 로딩을 엔트리 파일 **본문**에 두면 늦다.
 *   ESM/esbuild 는 import 를 호이스팅하므로, `src/lib/supabase/admin.ts` 처럼
 *   **모듈 최상단에서 클라이언트를 만드는** 모듈이 env 보다 먼저 평가된다
 *   (`supabaseUrl is required` 로 실측). preload 는 엔트리보다 먼저 실행되므로
 *   이 순서 문제가 원리적으로 발생하지 않는다.
 *
 * 사용: npx tsx --require ./scripts/qa/_a0-preload.cjs scripts/qa/yaj-a0-shadow-replay.ts
 */
const { readFileSync } = require("node:fs");

// 🔴 절대경로 하드코딩 금지 — 워크트리·CI·다른 사람 체크아웃에서 전부 깨진다.
//   repo 루트(이 파일 기준 ../..)의 `.env.local` 을 먼저 보고, 없으면 `.env` 를 본다.
//   `ENV_FILE` 로 명시 지정도 허용한다(CI 에서 다른 위치를 쓸 수 있게).
const { existsSync } = require("node:fs");
const { resolve } = require("node:path");
const CANDIDATES = [
  process.env.ENV_FILE,
  resolve(__dirname, "../../.env.local"),
  resolve(__dirname, "../../.env"),
].filter(Boolean);
const ENV_PATH = CANDIDATES.find((p) => existsSync(p)) ?? CANDIDATES[CANDIDATES.length - 1];

let loaded = 0;
for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
  const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (!m) continue;
  let v = m[2].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!process.env[m[1]]) {
    process.env[m[1]] = v;
    loaded += 1;
  }
}

// 필수 키가 없으면 **여기서 죽는다.** 없는 채로 진행하면 admin.ts 스택트레이스만
// 남고 "왜 없는지"는 안 보인다.
const REQUIRED = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`🔴 env preload 실패 — 누락: ${missing.join(", ")} (${ENV_PATH})`);
  process.exit(1);
}
console.log(`[env] ${loaded}개 로드 · supabase ${process.env.NEXT_PUBLIC_SUPABASE_URL.slice(8, 28)}…`);
