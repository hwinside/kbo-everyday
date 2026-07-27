# 커뮤니티 투표(Poll) 기능 — Spec

> 상태: DRAFT (CHECKPOINT 대기) · 작성 2026-07-27 · 요청자 하린아빠(#product `1785148197.626789`)
> 담당: 구현 삼식이 / 리뷰 삼순이

## 1. 목표

유저가 커뮤니티에 **투표글(Poll)** 을 작성한다. 선지는 팀/선수/기타 3종 중 한 타입으로만 구성하며,
팀·선수 선지는 **기존 커뮤니티 태그 시스템(TeamTagger/PlayerTagger, kboId `69100:구본혁` 체계)** 을 그대로 재사용해
로고·팀명·선수사진·이름을 자동 렌더한다.

## 2. 확정된 요구사항 (하린아빠 컨펌 완료)

| 항목 | 결정 |
|------|------|
| 선지 타입 | 팀 / 선수 / 기타 3종. **한 투표 = 단일 타입** (혼합 금지) |
| 선지 렌더 | 팀=로고+팀명, 선수=사진+이름 (기존 커뮤니티 태그 렌더 재사용), 기타=자유입력 텍스트 |
| 선지 개수 | 타입 무관 **2~10개** |
| 복수선택 | 작성자가 허용여부 선택. 허용 시 **최대 선택 제한 없음** |
| 마감시간 | 작성자 입력(필수). 마감 후 투표 불가 |
| 결과 공개 | 진행중: **투표해야** 중간결과 공개(미투표 시 비공개). **마감 후: 미투표자도 전체 열람 허용** |
| 투표 정책 | 1인 1표(단일선택) / 복수선택 시 1인 N표. **변경 가능**, 중복 불가 |
| 목록 노출 | 커뮤니티 목록에 표시 + **투표 전용 서버 렌더 썸네일** + `진행중`/`마감` 배지 + `n명 참여` |

## 3. 데이터 모델

기존 `posts`(태그 기반)에 poll을 얹는다. `board_type='poll'` 신규 값 + poll 전용 테이블 2개.

### 3.1 posts (기존, 최소 변경)
- `board_type` 에 `'poll'` 허용 (enum/check 확장, 레거시 값 유지)
- 제목=투표 질문(title), 본문=설명(content, 선택)
- `team_tags` / `player_tags` 는 선지에서 파생 채움(팀/선수 타입일 때) → 기존 태그 피드/검색과 자연 연동

### 3.2 poll_polls (신규)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| post_id | bigint PK FK→posts | 1:1 |
| option_kind | text CHECK in ('team','player','etc') | 선지 타입(단일) |
| allow_multiple | boolean NOT NULL default false | 복수선택 허용 |
| closes_at | timestamptz NOT NULL | 마감시간 |
| voter_count | int NOT NULL default 0 | **고유 참여자 수**(n명 참여, 표수 아님) |
| created_at | timestamptz default now() |

### 3.3 poll_options (신규)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial PK |
| post_id | bigint FK→posts (index) |
| position | int | 표시 순서 0~9 |
| kind | text | 'team'/'player'/'etc' (poll.option_kind와 일치 강제) |
| ref_id | text NULL | 팀 슬러그(`lg`) 또는 kboId(`69100`). etc면 null |
| label | text | 기타 자유입력 텍스트 / 스냅샷된 팀명·선수명 |
| image_url | text NULL | 스냅샷 로고·선수사진(없으면 null→fallback) |
| vote_count | int NOT NULL default 0 | 집계 캐시 |

> 팀명·선수명·이미지는 **작성 시점 스냅샷**(선수 이적/사진 변경에도 투표 표시는 고정). 렌더 로직만 기존 태그 컴포넌트 재사용.

### 3.4 poll_votes (신규)
| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | bigserial PK |
| post_id | bigint FK→posts (index) |
| option_id | bigint FK→poll_options |
| user_id | uuid FK→auth.users |
| created_at | timestamptz default now() |
| **UNIQUE(post_id, user_id, option_id)** | 같은 선지 중복 방지 |

- 단일선택: `(post_id, user_id)` 최대 1행 (앱/RPC 보장)
- 복수선택: `(post_id, user_id)` N행 허용
- **변경**: 해당 유저의 기존 votes 삭제 후 재삽입을 **단일 RPC(트랜잭션)** 로 원자 처리 → race/부분반영 차단
- 집계: `poll_options.vote_count` / `poll_polls.voter_count` 는 RPC 안에서 재계산 갱신(트리거 대신 RPC SSOT). LWW·중복카운트 회귀 필수

## 4. RLS / 서버 계약

- **결과 열람 게이트가 핵심 보안 지점**: 진행중 투표는 미투표자에게 `vote_count` 노출 금지.
  → 결과는 **service-role 서버 route/RPC** 로만 반환하고, 클라 직접 select로 집계 못 읽게 RLS 차단.
  route가 `voted || closed` 판정 후에만 수치 반환(미투표·진행중이면 총참여수만).
- 투표 write는 로그인 유저만, 마감 전만(서버 `now() < closes_at` fail-closed 재검증 — 클라 시간 불신).
- 작성/수정/삭제는 기존 posts 권한 축 재사용(+운영자 삭제).

## 5. API

| 엔드포인트 | 메서드 | 설명 |
|-----------|--------|------|
| `/api/polls` | POST | 투표 생성(질문+옵션 2~10+kind+allow_multiple+closes_at). 서버 검증: 단일 kind, 2~10개, closes_at>now |
| `/api/polls/[postId]` | GET | 투표 상세. 응답에 `canSeeResults`(voted∥closed) + 조건부 수치 |
| `/api/polls/[postId]/vote` | POST | 투표/변경(옵션 id 배열). RPC 원자 처리. 마감·비복수 위반 거부 |
| `/api/og/poll/[postId]` | GET(이미지) | **전용 썸네일 서버 렌더**(제목+상위 선지 미리보기+진행중/마감 배지+n명). 기존 `/api/og/post` 패턴 재사용 |

## 6. UI

- **작성 플로우**: 기존 `WriteEntrySheet`/`CommunityWriteFlow`에 "투표" 진입 추가 →
  ① 질문 입력 ② 선지 타입 선택(팀/선수/기타 세그먼트) ③ 타입별 입력:
  팀=TeamTagger 멀티, 선수=PlayerPickerSheet 멀티, 기타=텍스트 행 추가(2~10)
  ④ 복수선택 토글 ⑤ 마감시간 피커. **타입 전환 시 기존 선지 초기화 경고**.
- **목록 카드**(PostList/PostCard): poll이면 전용 썸네일 + `진행중`/`마감` 배지 + `👥 n명 참여`.
- **상세**: 미투표·진행중 → 선지 버튼만(결과 숨김). 투표/마감 → 막대그래프 %+표수+내 선택 하이라이트 + `변경` 버튼. 마감이면 투표 버튼 비활성 + `마감됨`.

## 7. 검증 (Goal-Driven)

- 단위/스모크: 옵션 개수 2~10 경계, 단일/복수 정책, 마감 전후 write 거부, **미투표 결과 은닉**, 변경 원자성, voter_count 고유성.
- RLS E2E(2계정): 미투표자가 진행중 투표 수치 못 읽음 / 투표 후 읽힘 / 마감 후 미투표자도 읽힘 / 마감 후 write 거부 / 변경 시 이전표 소멸·중복0.
- **End-User Level QA**(실 로그인): 작성→목록 썸네일/배지/n명→투표→중간결과→변경→마감표시. 팀/선수 로고·사진 자동 반영.
- query-guard·tsc·eslint·prod build PASS.

## 8. 슬라이스(구현 순서 — 빅뱅 금지)

1. **S1 DB+RPC+생성/투표 API** (스키마·RLS·원자 투표·결과 게이트) — 서버 계약 완성, 스모크+RLS E2E
2. **S2 작성 UI**(3타입 입력, 태그 재사용) + 상세 결과 UI
3. **S3 목록 노출**(전용 썸네일 OG 라우트, 진행중/마감 배지, n명)
4. **S4 마감 처리**(진행중→마감 전환은 `closes_at` 기준 계산, cron 불요) + End-User QA

각 슬라이스 = 별도 PR → 삼순이 리뷰 게이트 → 하린아빠 머지 승인.

## 9. 결정 대기(CHECKPOINT)

- 위 스펙 승인 여부. 승인 시 S1부터 착수.
- (경미) 마감시간 최소/최대 범위 제한 둘지 → 제안: 최소 10분, 최대 30일.
