# 커뮤니티 통합 피드 v2 — Spec

> 작성: 삼식이 (2026-05-29) · 스레드: #product 커뮤니티 UI 단순화 V3
> 목표: 글/사진 분리 구조를 인스타그램형 단일 피드로 통합. 게시글 상세 페이지 제거, 피드 안에서 좋아요/댓글 완결.
> 기존 WIP(`feature/community-unified-feed`)는 폐기하고 처음부터 재구현.

---

## 1. 배경 / 문제

- 글이 많지 않은데 **일반글 게시판 + 사진 게시판**이 분리, 거기에 **최신/인기** 토글까지 있어 복잡함만 가중.
- 게시글 → 상세 페이지 진입 동선이 브라우징을 끊고, 작성 글 노출도를 떨어뜨림.
- 과거 통합 시도(`feature/community-unified-feed`)는 인라인 댓글 시트의 iOS 포커스 문제로 무한 QA에 빠져 중단.

## 2. 목표 (Goal-Driven 성공 기준)

| # | 성공 기준 | 검증 방법 |
|---|-----------|-----------|
| G1 | 팀/선수/전체글이 **동일한 단일 피드 UI**로 렌더 (글·사진 탭 없음) | 코드 1개 피드 컴포넌트 공유 + 실기기 확인 |
| G2 | 짧은 글 = 배경 카드(팀=로고 스며듦/선수=선수사진 스며듦), 긴 글 = '더 보기' 펼침 | 스냅샷 + 실기기 |
| G3 | 게시글 상세 페이지 진입 **원천 차단**. 피드에서 바로 좋아요/댓글 | 라우트 제거 + 기존 딥링크 리다이렉트 |
| G4 | 댓글: 피드에 일부 노출 + '다른 댓글 보기'로 확대 | UI 확인 |
| G5 | **댓글 입력 모달 포커스 무이상** (iOS Safari/PWA) | `qa:ios-safari-keyboard` + 실기기 |
| G6 | 최신/인기 탭 제거 (최신순 단일 정렬) | 코드 + UI |
| G7 | 타 컴포넌트 영향 최소화 (Surgical) | `git diff --stat` 범위 리뷰 |
| G8 | 글쓰기 = 단일 통합 모달 (글 먼저 → 사진 선택 → 있으면 밈에디터/없으면 태그스텝). 제목 필드 제거 | 코드 1개 write 모달 + 실기기 |
| G9 | 댓글 입력 = 인스타 동일 플로우 (아이콘→시트 / 입력창→상단확대+키보드) | 실기기 |

## 3. 정보구조 변경

- **AS-IS 하위탭**: 전체글 · 전체사진 · 팀 · 선수 · 티켓 · 구장 · 자유
- **TO-BE 하위탭**: 전체글 · 팀 · 선수 · 티켓 · 구장 · 자유
  - `전체사진` 탭 삭제 (사진은 통합 피드에 섞임)
  - `전체글`: 팀/선수/자유 게시판 최신글 통합 브라우징
  - `팀`, `선수`: 글/사진 탭 제거 → 단일 스레드
  - `티켓`, `구장`, `자유`: 이번 범위에서 **변경 없음** (기존 유지)
- **전체글 / 팀 / 선수는 같은 피드 컴포넌트**를 source(보드 컨텍스트)만 바꿔 재사용.

## 4. 카드 렌더 규칙 (`UnifiedFeedItem`)

피드 한 항목은 `posts` row 1개. `content_type` + 첨부 + 길이로 카드 형태 결정:

| 케이스 | 조건 | 렌더 |
|--------|------|------|
| **A. 사진 카드** | `image_urls`/`video_urls` 있음 (content_type 무관) | 인스타형 캐러셀 + 캡션 2줄 클램프 + '더보기' |
| **B. 배경 텍스트 카드** | 첨부 0 + 본문 **짧음** (≤ 80자 & 링크 0, 하린아빠 확정) | 페북식 — 브랜드 배경 + 큰 텍스트 중앙 |
| **C. 일반 텍스트 카드** | 첨부 0 + 본문 김 (배경카드 조건 미달) | 일반 카드 + 3줄 클램프 + '더 보기' 인라인 펼침 |

**본문 표기** — 제목 필드 제거(§11). 기존 글(title 보유)은 **`title` + 줄바꿈 + `content`를 하나의 본문**으로 합쳐 렌더(제목 별도 강조 없음). 신규 글은 content만. 짧은 글 판정도 합쳐진 본문 길이 기준.

**배경 카드(B) 배경 소스** — 보드 컨텍스트 기준:
- 팀 게시판 글 → 해당 팀 컬러 + 팀 로고 스며듦 (NewsCarousel 기법: `linear-gradient(135deg, color-mix(in srgb, {teamBg} 35%, #1a1a1d), #1a1a1d)` + 로고 `opacity-20`)
- 선수 게시판 글 → 선수 사진(`/players/{kboId}.jpg`) 스며듦 + 어둡게 오버레이
- 자유 게시판 글 → 중립 다크 배경(또는 작성자 응원팀 컬러; §오픈이슈 Q3)
- 전체글에서는 각 글의 **원 보드 컨텍스트**를 그대로 따름 (팀글=팀, 선수글=선수, 자유글=중립)

모든 카드 공통: 작성자(팀뱃지+닉네임+시간) → 본문/미디어 → 액션바(좋아요/댓글) → 댓글 프리뷰(최대 2개) → '다른 댓글 보기' → 태그.

## 5. 댓글 / 좋아요 (인라인)

- **상세 페이지 제거**: `free/[postId]`, `teams/[teamId]/posts/[postId]`, `players/[playerId]/posts/[postId]` 라우트 삭제. 기존 딥링크는 보드 피드로 **리다이렉트**(가능하면 `?post=ID`로 해당 카드 스크롤/하이라이트).
- **댓글 입력 = 검증된 포털 패턴 재사용**: 현 `CommentSheet`(`src/components/community/CommentSheet.tsx`)는 이미 `createPortal(document.body)` + `visualViewport` pin(top=vvTop+offset, height=viewportHeight-offset) + `autoFocus` 미사용으로 **iOS 포커스 문제가 해결된 검증된 구현**. 그대로 재사용. **절대** 스크롤 컨테이너 내부 `position:fixed` + `bottom:keyboardInset` 방식 안 씀 — 구 브랜치 사망 원인은 CommentSheet가 아니라 *별도의 인라인 댓글 시도*였음(코드 주석 L163 명시).
  - 참고: `PhotoFeed`는 이미 카드 클릭 시 상세로 안 가고 CommentSheet를 inline으로 연다 → 통합 피드가 따라갈 검증된 모델.
- **댓글 모달 플로우 (인스타 동일, 하린아빠 스샷 3장 확정)**:
  - (a) 댓글 보기 전: 카드 액션바 + 프리뷰 댓글 일부
  - (b) 댓글 아이콘 클릭 → `CommentSheet` 바텀시트 오픈 (화면 ~절반, 입력창은 하단, autoFocus 없음)
  - (c) 입력창 클릭 → 시트가 화면 상단까지 확대 + 키보드 노출 (visualViewport pin)
  - → 이 3단계는 현 `CommentSheet`의 포털+visualViewport 구현으로 (b)(c) 모두 커버됨. 신규 추가는 (a)→(b) 트리거(댓글 아이콘)뿐.
- **댓글 프리뷰**: 카드에 최신/베스트 댓글 최대 2개 inline 표시. '다른 댓글 보기 (N)' → 같은 `CommentSheet` 전체 열기.
- **좋아요**: 피드에서 바로 토글(optimistic). ⚠️ **배치 좋아요 프리페치는 신규 작업** — 현재 어디에도 없음(PhotoFeed는 진입 시 하트 전부 빈 상태로 시작, 상세 진입해야 내 좋아요 확인). 신규 `useUnifiedFeed`에서 보이는 글들의 내 좋아요 상태 **배치 조회**(`likes` where `post_id in [...]` and `user_id=me`) 1회 추가.

## 6. 데이터 / 패칭

- 단일 `posts` 테이블, `content_type ∈ {general, photo}` 모두 한 쿼리로 (필터 제거).
- **타입 통일**: `usePosts.ts`의 snake_case `Post` 형태로 단일화(PhotoFeed/CommentSheet가 이미 사용). camelCase 매핑 신규 코드에서 제거.
- **커서 기반 무한 스크롤 신규 도입** (현재 30/100 하드캡 → 무한). `order(created_at desc, id desc)` + `(created_at,id) < cursor` keyset. React Query 미도입 — 기존 raw supabase + useEffect 패턴 유지(신규 `useUnifiedFeed` 훅).
  - 보드별 쿼리:
    - 팀: `board_type='team' AND board_id={teamId}`
    - 선수: `board_type='player' AND board_id={kboId}`
    - 전체글: `board_type IN ('team','player','free')` (game 제외)
- **DB 스키마 변경 0건** 목표 (컬럼 추가 없이 기존 필드로 구현).

## 7. 범위 밖 (Non-goals)

- 티켓/구장/자유 게시판 자체 리뉴얼 (자유는 전체글 소스로만 포함)
- 인기글 알고리즘, 별도 '더 보기' 아카이브 경로 (향후 글 누적 시 §스샷2 형태로 별도 진행)
- 신규 DB 컬럼/마이그레이션
- 좌석팁(`WritePost` seatTipMode)·구장 게시판 작성 폼 — 이번 통합 대상 아님(기존 유지)

## 8. 구현 순서 (얇은 수직 슬라이스)

> 각 슬라이스 = 1 PR. 삼식이 구현 → 삼순이 리뷰 → GO → 다음 슬라이스. 무한 QA 방지 위해 슬라이스마다 자동 QA(스냅샷/Playwright) 첨부.

- **S0. 정리/기반**: 구 WIP 브랜치 폐기 확인. `useUnifiedFeed` 훅(커서 페이징 + content_type 통합 + 좋아요 배치) + snake_case Post 단일화. 단위 검증.
- **S1. UnifiedFeed 컴포넌트 + 카드 3종**: A(사진=기존 PhotoFeed 캐러셀 재사용)/B(배경 텍스트)/C(일반 텍스트 더보기) + title+content 합산 본문 렌더. 정적 목 데이터로 스냅샷 QA.
- **S2. 인라인 댓글/좋아요**: CommentSheet 포털 재사용 + 댓글 아이콘→시트 트리거 + 댓글 프리뷰 2개 + '다른 댓글 보기' + 좋아요 optimistic. iOS 키보드 QA(`qa:ios-safari-keyboard`).
- **S3. 라우팅 통합**: 팀/선수/전체글 페이지를 UnifiedFeed로 교체, 글/사진·최신/인기 탭 제거, 하위탭 7→6. 선수 페이지는 stats 섹션 유지 + 스레드 단일화.
- **S4. 상세 페이지 제거 + 딥링크 리다이렉트**: 3개 상세 라우트 삭제, 리다이렉트, dead CSS(`postdetail-chat-container`, `body.kbd-open` 등 상세 전용) 정리. PostList→PostCard 내비게이션 제거.
- **S5. 글쓰기 통합 모달** (§11): `WritePost`(title 폼) + `WritePhotoPost`(3스텝) → 단일 `WriteComposer`로. 글 입력 먼저 → 사진 선택적 → 첨부 시 밈에디터, 미첨부 시 태그스텝. 제목 필드 제거. 좌석팁 모드는 `WritePost`에 잔류(범위 밖). 스냅샷 + 실기기.
- **S6. End-User QA**: 테스트 유저 로그인 → 전체/팀/선수 피드 동일 UI + 짧은/긴 글 + 사진 + 댓글 모달 a/b/c 포커스 + 좋아요 + 글쓰기 통합 모달(사진 유/무 분기) + 딥링크 리다이렉트 실유저 레벨 검증. → 하린아빠 실기기 QA 인계.

## 9. 오픈 이슈

- **Q1. 짧은 글 임계값**: ✅ 해결 — **본문(title+content 합산) ≤ 80자 & 첨부 0 & 링크 0** (하린아빠 2026-05-29 확정).
- **Q2. 긴 글 펼침**: 일반 텍스트 카드 클램프 줄 수. 제안 = **3줄 후 '더 보기'**(피드 내 인라인 펼침, 상세 이동 없음). → 삼식이 자율 진행, 실기기서 조정.
- **Q3. 자유게시판 짧은 글 배경**: 중립 다크 vs 작성자 응원팀 컬러. 제안 = **작성자 응원팀 컬러**(`author_team_id_snapshot` 활용, 없으면 중립). → 삼식이 자율 진행.
- **Q4. 딥링크 리다이렉트 깊이**: 단순 보드 피드 이동 vs `?post=ID` 스크롤/하이라이트. 제안 = **`?post=ID` 하이라이트**(공유 링크 UX 유지). → 삼식이 자율 진행.

## 11. 글쓰기 통합 모달 (`WriteComposer`) — S5 상세

현 상태: `WritePost`(제목+내용, 좌석팁 겸용) / `WritePhotoPost`(3스텝: 미디어→밈에디터→태그). 밈에디터(`@/components/editor/MemeEditor`)는 main 머지 완료.

TO-BE 단일 플로우 (하린아빠 2026-05-29 점 3 확정):
1. **글 입력 먼저** — 제목 없이 본문 textarea 하나 + 하단 "사진 첨부"(선택) 버튼. (인스타 작성 1화면)
2. **사진 첨부 O** → 밈에디터 단계로 이동(기존 `WritePhotoPost` step2 로직 재사용) → 이후 태그 스텝.
3. **사진 첨부 X** → 곧장 **태그 스텝**(기존 step3: 게임/선수/해시태그, 본문은 이미 입력했으므로 caption 입력란은 1번 본문으로 대체).
4. 제출 → `createPost`. `contentType`은 미디어 유무로 결정(`photo`/`general`), `title: ""` 고정.

- **제목 필드 완전 제거**. 기존 글 표기는 §4 본문 표기 규칙(title+content 합산)으로 흡수.
- 좌석팁(`seatTipMode`)·구장 작성은 이 통합 대상 아님 → `WritePost` 잔존 또는 좌석팁 전용 경량 폼 유지.
- 진입점: 각 보드 FAB '글쓰기' 버튼이 `WriteComposer` 하나만 호출(현재는 보드 종류별로 WritePost/WritePhotoPost 분기).

## 10. 현황 검증 (2026-05-29, code-explorer)

확인된 기준 파일:
- 탭 네비/레이아웃: `src/app/(main)/community/layout.tsx` (탭 7개: all-posts·all-photos·teams·players·tickets·stadiums·free, 상세페이지에서 탭 숨김)
- 루트 리다이렉트: `src/app/(main)/community/page.tsx` (myTeam 쿠키 시 `/teams/[slug]`)
- 글/사진(="일반/사진") + 최신/인기 토글: `teams/[teamId]/page.tsx` L163~199 (정렬은 클라 사이드)
- 상세 라우트 3종 + 진입: `PostList.tsx` L50~58 (`boardType` 분기 router.push). **PhotoFeed는 상세 진입 없음**(inline CommentSheet)
- 데이터 훅: `usePosts.ts` (snake_case Post, `.limit(30)`, `toggleLike`). 경쟁 camelCase Post: `src/lib/types/index.ts` — all-posts/all-photos는 inline `.limit(100)` 별도 쿼리
- 컬럼 전부 확인: `content_type`·`board_type`·`board_id`·`image_urls`·`video_urls`·`author_team_id_snapshot`(`20260526_*.sql`)
- 배경 기법: `NewsCarousel.tsx` L93~125 — `linear-gradient(135deg, color-mix(in srgb, {teamBg} 35%, #1a1a1d), #1a1a1d)` + 로고 80px `opacity-20` + 하단 스크림

스펙 수정 2건:
- **좋아요 배치 프리페치 = 신규 작업** (기존 패턴 없음) → §5 반영
- **CommentSheet = 이미 검증된 안전 구현** (구 브랜치 사망은 별도 인라인 시도) → §5 반영
