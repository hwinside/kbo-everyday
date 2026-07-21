# QA Scripts

## Supabase collection query guard

`npm run qa:query-guard` scans production and operational TypeScript/JavaScript for
Supabase SELECT/RPC, Storage list, and Auth listUsers calls. New unbounded reads,
non-unique range pagination, and custom full scans that do not use the shared
fail-closed keyset helper fail the build.

Existing findings are frozen in `query-pagination-baseline.json`. Both a new finding
and a resolved finding fail until the reviewed baseline is regenerated, so a removed
finding cannot be reintroduced under an old count. `query-pagination-policy.json`
also classifies every migration relation as growing or bounded; an unclassified new
table fails before baseline comparison. Composite unique keys are listed as key sets.

```ts
// query-guard: bounded -- one user's rows behind an authenticated user id
// query-guard: bounded-page -- UI intentionally returns one stable page only
// query-guard: full-scan -- unique id keyset through fetchAllByKeyset
```

`full-scan` is accepted only when the query is structurally inside a trusted helper
callback and contains the cursor predicate, complete unique order, and page limit.

When a reviewed audit intentionally resets the baseline, run
`QUERY_GUARD_BASE_SHA=$(git rev-parse HEAD) node scripts/qa/query-pagination-guard.mjs --write-baseline`.

삼순이(QA)가 배포 직후 *최종 사용자 QA*까지 한 번에 찍을 수 있는 CLI 모음.

## 왜 있음?

크보팬은 Google OAuth만 지원해서 자동화된 브라우저 로그인이 reCAPTCHA에 막힙니다.
그래서 Supabase Admin API로 *일회용 테스트 유저*를 생성하고, 세션 토큰을 브라우저에 주입해
실제 로그인된 상태에서 UI 분기·RLS·트리거를 모두 검증합니다.

테스트 유저는 매 실행마다 자동 생성·삭제됩니다 — DB에 잔여 없음.

## 전제

- `.env.local`에 다음 값이 있어야 함:
  - `NEXT_PUBLIC_SUPABASE_URL`
  - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
- 루트에서 `npm install` 한 번 (playwright 포함됨)
- Playwright 브라우저 바이너리 설치: `npx playwright install chromium` (최초 1회)

## 실행

### 댓글/게시글 수정·삭제 v1

```bash
# 기본 (headless, prod 대상)
node scripts/qa/ui-smoke-comment-crud.mjs

# 로컬 dev 서버 대상
node scripts/qa/ui-smoke-comment-crud.mjs --base-url=http://localhost:3000

# 브라우저 창 눈으로 보기
node scripts/qa/ui-smoke-comment-crud.mjs --headed
```

### 출력 예시

```
[15:37:05] users ready: d3370edd 41e3afd0
[15:37:05] post url: https://keubo.fan/community/teams/doosan/posts/1680
  ✅  [2] A 본인 콘텐츠 ⋯ 메뉴 표출 (기대: 2)
  ✅  [2a] 게시글 메뉴 → 수정/삭제 옵션 노출
  ✅  [3] B 다른 유저 콘텐츠 ⋯ 메뉴 숨김 (기대: 0)
  ✅  [4a] 댓글 INSERT 후 comment_count = 2
  ✅  [4b] A 본인 댓글 수정 성공
  ...
=== RESULT: 13/13 PASS ===
screenshots: /Users/.../tmp/qa-screenshots
```

스크린샷 2장(`A-own-post.png`, `B-others-post.png`)이 저장되므로 눈으로도 확인 가능.

## npm script alias

루트 `package.json`에 추가돼 있음:

```bash
npm run qa:ui:comment-crud
```

## 새 QA 스크립트 작성

- `scripts/qa/_env.mjs`를 import해서 env 자동 로드
- 일회용 유저는 `admin.auth.admin.createUser` → `finally`에서 `deleteUser`
- 세션 주입은 `injectSession()` 패턴 재사용 (쿠키 + localStorage 둘 다 필수)
- 검증은 `check(name, bool, msg)` 유틸로 PASS/FAIL 집계

## 주의

- `@keubo.fan` 이메일은 삼식이 QA 전용 — 실제 유저와 충돌 안 남
- 실패 시 프로세스 종료 코드 1 → CI에 엮기 좋음
- `tmp/qa-screenshots/` 는 `.gitignore`에 이미 포함 (tmp/)
