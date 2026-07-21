# 기사별 댓글 — Spec

## 목표

뉴스 원문을 크보팬 인앱 브라우저로 읽는 흐름은 유지하면서, 기사마다 크보팬 유저가 별도의 댓글방에서 대화할 수 있게 한다.

## 원칙

- 언론사 본문은 저장·복제·재배포하지 않는다.
- 기사 제목, 출처, 썸네일, 원문 URL만 댓글방 식별 및 UI 문맥용으로 저장한다.
- 기존 `CommentSheet`의 로그인, 답글, 좋아요, 이미지/GIF, 수정·삭제, 운영자 삭제, 신고·블라인드 정책을 그대로 재사용한다.
- 같은 기사가 홈·팀·선수·뉴스클리핑에 중복 노출되어도 댓글방은 하나다.
- 뉴스 카드의 원문 열기와 댓글 열기는 독립 동작이어야 한다.

## 사용자 시나리오

1. 유저가 뉴스 카드의 `댓글` 버튼을 누른다.
2. 서버가 정규화된 기사 URL로 기존 댓글방을 조회하거나 최초 1회 생성한다.
3. 기존 `CommentSheet`가 열리고 댓글을 읽을 수 있다.
4. 비로그인 유저가 작성·좋아요를 시도하면 기존 `LoginSheet`가 열린다.
5. 카드 본문을 누르면 기존처럼 원문이 인앱 브라우저(웹은 새 탭)에서 열린다.
6. 홈 뉴스카드에는 기사별 현재 댓글 수가 표시되고, 작성·삭제 직후 즉시 갱신된다.

## 적용 범위

- 홈 `NewsCarousel`
- 팀 뉴스 페이지
- 선수 상세의 관련 기사
- 운영팀 뉴스클리핑 카드
- 공용 `NewsCard`

공식 영상·하이라이트 댓글은 이번 슬라이스에서 제외한다.

## 데이터 모델

### `news_discussions`

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `article_key` | `text` PK | 정규화 URL의 SHA-256 hex |
| `post_id` | `bigint` unique FK | 기존 댓글 스택용 숨김 브리지 포스트 |
| `canonical_url` | `text` | 정규화된 기사 원문 URL |
| `source_url` | `text` | 실제 카드 클릭 URL |
| `title` | `text` | 기사 제목 스냅샷 |
| `source` | `text null` | 언론사/호스트 |
| `thumbnail_url` | `text null` | 카드 썸네일 URL |
| `team_id` | `int null` | 팀 컬러 문맥 |
| `created_at` | `timestamptz` | 생성 시각 |
| `updated_at` | `timestamptz` | 메타데이터 갱신 시각 |

- 브리지 포스트는 `board_type='news'`, `board_id=article_key`, `is_hidden=true`로 생성한다.
- 브리지 포스트는 일반 피드·게시글 통계에서 제외하되, 실제 댓글 활동은 댓글 통계에 포함한다.
- `news_discussions`는 RLS를 켜고 클라이언트 직접 쓰기 정책을 두지 않는다. 생성·조회는 서버 API가 담당한다.

## 기사 키 정규화

1. `http:`/`https:` URL만 허용한다.
2. hostname은 소문자로 만들고 hash를 제거한다.
3. `utm_*`, `fbclid`, `gclid` 등 추적 파라미터를 제거한다.
4. 나머지 query parameter를 키·값 순으로 정렬한다.
5. 루트가 아닌 path의 마지막 `/`를 제거한다.
6. `originalLink`/`ogUrl`이 있으면 canonical 후보로 우선하고, 실제 클릭 URL은 별도로 보존한다.
7. 정규화 URL의 SHA-256을 `article_key`로 사용한다.

## API

### `POST /api/news/discussion`

요청:

```json
{
  "url": "실제 클릭 URL",
  "canonicalUrl": "언론사 원문 URL(선택)",
  "title": "기사 제목",
  "source": "언론사(선택)",
  "thumbnailUrl": "썸네일(선택)",
  "teamId": 1
}
```

응답:

```json
{ "postId": 123, "commentCount": 4 }
```

- 같은 `article_key` 요청은 기존 `post_id`를 반환하고 최신 메타데이터만 갱신한다.
- 동시 최초 생성 시 unique 충돌을 처리하고 패배한 임시 브리지 포스트를 제거한다.
- URL/문자열 길이/팀 ID를 검증하며, IP 기준 best-effort rate limit을 둔다.
- `SUPABASE_SERVICE_ROLE_KEY`와 `SYSTEM_USER_ID`가 없으면 fail closed 한다.

### `POST /api/news/discussion/counts`

- 홈에 노출된 기사 `{ lookupId, url, canonicalUrl }` 목록(최대 10개)을 한 번에 받아 `{ lookupId: commentCount }`를 반환한다. 서버 내부 조회는 SHA-256 `article_key`로 수행한다.
- 댓글방이 아직 없는 기사는 `0`으로 반환하며, 댓글 수 조회만으로 빈 브리지 포스트를 만들지 않는다.
- 홈 카드별 개별 요청(N+1)은 금지한다.

## UI/접근성

- 홈 뉴스카드 댓글 버튼에는 `MessageCircle` 아이콘과 현재 댓글 수(`0` 포함)를 표시한다.
- 홈 이외 경로는 이번 슬라이스에서 `댓글` 라벨을 기본으로 하며, 댓글 시트를 연 뒤에는 확인된 댓글 수를 표시할 수 있다.
- 댓글 작성·삭제 성공 시 해당 홈 카드 수치를 낙관적으로 즉시 반영하고 서버 값으로 재동기화한다.
- 댓글 버튼 클릭은 원문 열기 이벤트를 `preventDefault`/`stopPropagation`으로 차단한다.
- 버튼 준비 중에는 중복 요청을 막고, 실패 시 짧은 오류 안내 후 원문 열기 기능은 정상 유지한다.
- interactive element 중첩을 만들지 않도록 카드 wrapper와 원문 버튼/링크를 분리한다.
- 댓글 시트를 닫으면 기존 스크롤 위치가 복원된다.

## 비기능 요구사항

- 기사 본문 저장 0건.
- 동일 canonical URL에 브리지 포스트 최대 1개.
- 홈 뉴스 10건의 댓글 수는 단일 배치 요청으로 조회한다.
- 일반 뉴스 원문 열기 동작에 회귀가 없어야 한다.
- 신규 패키지 의존성은 추가하지 않는다.

## 완료 기준

- URL 정규화 단위 테스트 통과.
- API 검증·멱등성·동시 충돌·댓글 수 배치 조회 경로 테스트 통과.
- 뉴스 5개 노출 경로에서 댓글 시트 열기와 원문 열기 분리 확인.
- 비로그인 열람/로그인 유도, 로그인 댓글 작성·수정·삭제, 운영자 삭제를 End-User Level로 확인.
- `tsc --noEmit`, 대상 ESLint, 프로덕션 빌드 통과.
