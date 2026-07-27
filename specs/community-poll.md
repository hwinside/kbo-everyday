# 커뮤니티 투표(Poll) 기능 — Spec

> 상태: DRAFT v2 (삼순 NO-GO 4건 반영, 재리뷰 대기) · 작성 2026-07-27 · 요청자 하린아빠(#product `1785148197.626789`)
> 담당: 구현 삼식이 / 리뷰 삼순이

## 1. 목표

유저가 커뮤니티에 **투표글(Poll)** 을 작성한다. 선지는 팀/선수/기타를 섞어 넣되
**팀 선지와 선수 선지는 같은 투표에서 공존 금지**(기타는 어느 쪽과도 조합 가능).
팀/선수 선지는 **기존 커뮤니티 태그 시스템(TeamTagger/PlayerTagger, `teamId`/kboId `69100` 체계)** 을 그대로 재사용하고,
이름·로고·선수사진은 **현재 SSOT에서 canonical `ref_id`로 렌더**(로스터/이미지 변경 자동 반영), 스냅샷은 fallback으로만 둔다.

## 2. 확정된 요구사항 (하린아빠 + 삼순 반영)

| 항목 | 결정 |
|------|------|
| 선지 타입 | 팀 / 선수 / 기타. 선지마다 kind. **팀+선수 공존만 금지, 기타는 혼합 허용** |
| 선지 렌더 | 팀=로고+팀명, 선수=사진+이름(기존 태그 렌더 재사용, `ref_id` SSOT), 기타=자유입력 텍스트 |
| 선지 개수 | kind 무관 **총합 2~10개** |
| 복수선택 | 작성자가 허용여부 선택. 허용 시 **상한 없음(선지 전체까지)** |
| 마감시간 | 작성자 입력(필수). 허용범위 **최소 10분 ~ 최대 30일**. 마감 후 투표 불가 |
| 결과 공개 | 진행중: **투표해야** 중간결과 공개(미투표 비공개). **마감 후: 전원 열람 허용** |
| 투표 정책 | 유저당 ballot(단일선택 1표 / 복수선택 N표). **변경 가능**, 중복 불가 |
| 불변 규칙 | **첫 투표 이후 질문·선지·복수선택 설정 수정 금지** (삼순) |
| 목록 노출 | 커뮤니티 목록에 표시 + **서버 렌더 Poll 전용 카드 썸네일** + `진행중`/`마감` 배지 + `n명 참여`(고유 유저 수) |

## 3. 데이터 모델

기존 `posts`(태그 기반)에 poll을 얹는다. `board_type='poll'` 신규 값 + poll 전용 3테이블.

### 3.1 posts (기존, 최소 변경)
- `board_type` 에 `'poll'` 허용(check 확장, 레거시 값 유지). title=질문, content=설명(선택).
- 팀/선수 선지의 `teamId`/kboId를 `team_tags`/`player_tags`에 파생 채움 → 기존 태그 피드/검색 자연 연동.

### 3.2 poll_polls (신규) — **option_kind 없음**
| 컬럼 | 타입 | 설명 |
|------|------|------|
| post_id | bigint PK FK→posts ON DELETE CASCADE | 1:1 |
| allow_multiple | boolean NOT NULL default false | 복수선택 허용 |
| closes_at | timestamptz NOT NULL | 마감(생성 시 10분~30일 CHECK/RPC 검증) |
| voter_count | int NOT NULL default 0 | **고유 참여자 수**(유저 수) |
| first_vote_at | timestamptz NULL | 최초 투표 시각 → 이후 편집 잠금 판정 |
| created_at | timestamptz default now() |

> poll에는 타입 컬럼을 두지 않는다. 조합 규칙(팀+선수 금지)은 **생성 RPC에서 옵션 kind 집합 검증**.

### 3.3 poll_options (신규)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial PK |
| post_id | bigint FK→posts ON DELETE CASCADE (index) |
| position | int | 표시/작성 순서 0~9 |
| kind | text CHECK in ('team','player','etc') | 선지 타입(선지별) |
| ref_id | text NULL | 팀 슬러그(`lg`)/kboId(`69100`). etc=null. **렌더는 이걸로 현재 SSOT 조회** |
| label_snapshot | text NULL | 팀명·선수명 스냅샷(SSOT 조회 실패 시 fallback). etc=자유입력 본문 |
| image_snapshot | text NULL | 로고·선수사진 스냅샷(fallback 전용) |
| vote_count | int NOT NULL default 0 | 집계 캐시 |
| **UNIQUE(post_id, id)** | poll_votes 복합 FK 대상(소속 강제) |

### 3.4 poll_votes (신규)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial PK |
| post_id | bigint FK→posts ON DELETE CASCADE (index) |
| option_id | bigint | |
| user_id | uuid FK→auth.users ON DELETE CASCADE |
| created_at | timestamptz default now() |
| **FK(post_id, option_id) → poll_options(post_id, id)** | 옵션의 post 소속 강제(타 poll 옵션 투표 차단) |
| **UNIQUE(post_id, user_id, option_id)** | 같은 선지 중복 방지 |

- 단일선택: 앱/RPC가 `(post_id,user_id)` 최대 1행 보장. 복수선택: N행 허용.

## 4. RLS / 은닉 (보안 핵심 — 삼순 반영)

- `poll_options`·`poll_votes`·`poll_polls` **집계 컬럼은 anon·authenticated 직접 SELECT 0**(RLS deny). 옵션의 라벨/순서 등 비민감 메타만 별도 정책으로 노출하거나, 전량 RPC 경유.
- 투표/생성/결과 **RPC는 EXECUTE 서버 전용**(service-role). 클라가 RPC 직접 호출 불가.
- 결과 GET route는 **검증된 JWT의 uid로 `voted ∥ closed` 판정** 후에만 수치 반환. 미투표·진행중이면 `voter_count`(참여수)만.
- 활성(진행중) 응답 헤더 **`Cache-Control: private, no-store`** (CDN·프록시 캐시로 결과 누출 방지).
- **OG/썸네일의 "상위 선지"는 득표순 금지 → 작성순(position)** 노출(진행중 우회 노출 차단).
- 클라 시간 불신: write는 서버 `now() < closes_at` fail-closed 재검증.

## 5. API / RPC

| 엔드포인트 | 설명 |
|-----------|------|
| `POST /api/polls` | **단일 트랜잭션 RPC** `create_poll(...)`: posts + poll_polls + poll_options 원자 생성. 서버 검증: 옵션 2~10, kind 집합에 team&player 동시 금지, closes_at 10분~30일, etc label 비어있지 않음 |
| `GET /api/polls/[postId]` | 상세. `canSeeResults=voted∥closed` 판정, 조건부 수치. `private,no-store`(활성) |
| `POST /api/polls/[postId]/vote` | **투표/변경 RPC** `cast_poll_vote(post,user,option_ids[])`: (post,user) advisory/직렬화 락 → 마감·빈선택·중복·단일선택 위반 DB 검증 → 기존 ballot 삭제→삽입 → **poll-row lock 하 vote_count/voter_count 재계산** (동시 타 유저 투표 stale 방지) |
| `GET /api/og/poll/[postId]` | 서버 렌더 Poll 카드(질문 + **작성순** 선지 미리보기 + 진행중/마감 배지 + n명). `/api/og/post` 패턴 재사용 |

- **삭제 정합성**: post/계정 삭제 시 CASCADE로 options/votes 제거, 관련 poll 집계·목록 카드 정합 유지(E2E로 검증).

## 6. UI

- **작성 플로우**(기존 `WriteEntrySheet`/`CommunityWriteFlow`에 "투표" 진입): 질문 → 선지 행 추가(각 행마다 팀/선수/기타 선택; 팀=TeamTagger, 선수=PlayerPickerSheet 재사용, 기타=텍스트). **팀 선지와 선수 선지가 한 투표에 동시 존재하면 UI 원천 차단**(기타는 자유). 복수선택 토글 + 마감시간 피커(10분~30일). 선수 검색 행은 기존처럼 팀·포지션·등번호 노출.
- **목록**(PostList/PostCard): poll이면 전용 카드 썸네일 + `진행중`/`마감` + `👥 n명 참여`.
- **상세**: 미투표·진행중 → 선지 버튼만(결과 숨김). 투표/마감 → 막대 %+표수+내 선택 하이라이트+`변경`. 마감 → 투표 비활성 `마감됨`, 전원 결과 공개. **첫 투표 이후 작성자도 질문/선지/설정 수정 불가**.

## 7. 검증 (Goal-Driven) — S1에 RLS·동시성·cascade E2E 포함

- 단위/스모크: 옵션 2~10 경계, 팀+선수 공존 거부·기타 혼합 허용, closes_at 범위, 단일/복수 정책, 마감 전후 write 거부, first_vote 후 편집 잠금.
- **RLS/동시성 E2E(2계정)**: ①미투표자 진행중 수치 못 읽음 ②투표 후 읽힘 ③마감 후 미투표자도 읽힘 ④마감 후 write 거부 ⑤변경 시 이전표 소멸·중복0 ⑥**동시 투표 2계정 → voter_count/vote_count stale 없음(poll-row lock)** ⑦타 poll 옵션 투표 복합 FK 거부 ⑧post/계정 삭제 CASCADE 후 집계·목록 정합.
- **End-User Level QA(S4, 실 로그인)**: 작성→목록 썸네일/배지/n명→투표→중간결과→변경→마감표시, 팀/선수 로고·사진 SSOT 자동 반영.
- query-guard·tsc·eslint·prod build PASS.

## 8. 슬라이스(빅뱅 금지)

1. **S1 DB+RPC+API+E2E** — 스키마·RLS·생성/투표 단일 트랜잭션 RPC·결과 게이트·**계산형 마감 판정(계약에 포함)**·2계정 RLS/동시성/cascade E2E. 서버 계약 완성.
2. **S2 작성 UI**(3 kind 행, 팀+선수 공존 차단, 태그 재사용) + 상세 결과 UI(변경·마감표시·편집잠금).
3. **S3 목록 노출**(OG poll 카드 라우트=작성순, 진행중/마감 배지, n명).
4. **S4 통합 End-User QA** + 마무리.

각 슬라이스 = 별도 PR → 삼순 리뷰 게이트 → 하린아빠 머지 승인.

## 9. 결정 로그

- 마감 허용범위 10분~30일 — 삼순 GO.
- 팀+선수 공존만 금지(기타 혼합 허용), 총합 2~10 — 하린아빠 확정.
- 렌더는 ref_id SSOT + 스냅샷 fallback — 삼순.
- 첫 투표 후 편집 잠금 — 삼순.
