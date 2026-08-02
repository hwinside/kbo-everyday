#!/usr/bin/env node
/**
 * 네이버 로그인 기존 유저 조회 계약 회귀.
 *
 * 2026-08-02 P0: 콜백이 `listUsers` 를 20페이지(=상위 2만 명)까지만 훑어서,
 * 유저가 2만 명을 넘긴 순간(7/28 04:07) 가장 오래된 가입자부터 조회 범위 밖으로
 * 밀려났다 → 기존 유저 미발견 → createUser → email_exists → login_error.
 * 구가입자 약 5천 명이 네이버 로그인 전면 불가.
 *
 * 같은 유형이 4/21(perPage 50 → 1000)에도 있었다. 상한을 올리는 대응은
 * 유저 수가 자라면 반드시 재발하므로, 이 회귀는 "상한을 올렸는지"가 아니라
 * **유저 규모에 의존하는 조회로 되돌아갔는지**를 잠근다.
 */
import { readFileSync } from "node:fs";

const FILE = "src/app/api/auth/naver/callback/route.ts";
const src = readFileSync(FILE, "utf8");

let failures = 0;
const check = (name, ok, detail = "") => {
  if (ok) console.log(`  ✅ ${name}`);
  else {
    failures += 1;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
};

// 조회 블록만 잘라서 본다 (파일 전체 grep 이면 무관한 코드에 걸린다)
const start = src.indexOf("const normalizedEmail");
const end = src.indexOf("let userId: string;");
check("[구조] 이메일 조회 블록 존재", start > 0 && end > start);
if (!(start > 0 && end > start)) {
  console.log("\nFAIL 1 / exit 1");
  process.exit(1);
}
const block = src.slice(start, end);

// 1) 핵심: 페이지 상한 순회로 되돌아가지 않았는가
check(
  "[P0] 조회에 page 상한 루프(for page<=N)가 없음",
  !/for\s*\(\s*let\s+page\s*=/.test(block),
  "페이지 상한 순회는 유저 수가 상한을 넘는 순간 조용히 구가입자를 잃는다",
);
check(
  "[P0] 조회가 auth.admin.listUsers 페이지네이션에 의존하지 않음",
  !/auth\.admin\.listUsers\s*\(/.test(block),
  "listUsers 는 created_at DESC + 페이지 상한이라 규모 의존",
);

// 2) 서버측 filter 검색을 GoTrue REST 로 직접 호출하는가
//    (supabase-js listUsers 는 filter 를 query 에 싣지 않아 조용히 무시된다)
check(
  "[구현] GoTrue admin REST /auth/v1/admin/users 직접 호출",
  block.includes("/auth/v1/admin/users"),
);
check("[구현] filter 파라미터로 서버측 검색", /searchParams\.set\(\s*"filter"/.test(block));
check(
  "[구현] service_role 키로 인증",
  block.includes("SUPABASE_SERVICE_ROLE_KEY") && block.includes("Authorization"),
);

// 3) filter 는 부분일치(LIKE) → exact 재확인이 반드시 있어야 한다
check(
  "[정확성] 정규화 이메일 exact 일치로 재확인",
  /\.find\(/.test(block) &&
    block.includes("trim().toLowerCase()") &&
    block.includes("=== normalizedEmail"),
  "filter 는 LIKE 라 users[0] 을 그대로 쓰면 남의 계정에 로그인시킬 수 있다",
);

// 4) 조회 실패를 '신규 유저'로 흘려보내지 않는다 (fail-close)
check("[fail-close] 조회 실패 상태를 추적하는 플래그 존재", /lookupOk/.test(block));
check(
  "[fail-close] 조회 실패 시 createUser 로 진행하지 않고 login_error 로 종료",
  /if\s*\(\s*!lookupOk\s*\)/.test(src) && src.includes("login_error=lookup_error"),
  "판별 불가를 성공처럼 처리하면 이번 사고와 동일 증상(중복 createUser)이 재발",
);
const failCloseIdx = src.indexOf("if (!lookupOk)");
const createUserIdx = src.indexOf("admin.createUser");
check(
  "[fail-close] 게이트가 createUser 보다 앞에 위치",
  failCloseIdx > 0 && createUserIdx > failCloseIdx,
);

console.log(failures === 0 ? "\nPASS — 10/10" : `\nFAIL ${failures} / exit 1`);
process.exit(failures === 0 ? 0 : 1);
