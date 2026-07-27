# 직관 다이어리 — 미디어 privacy 근본 재설계 (A안)

> 상태: A안 승인됨 (하린아빠 2026-07-26 "A안으로 가자") — private-first + signed URL + archive status-only 단일 계약
> 담당: 구현 삼식 · 리뷰 삼순 · 머지 승인 하린아빠
> 관련 기존: `직관 다이어리 v1`(venue_attendance = 승·무·패/승률), `직관 라이브`(venue_stories = 스토리)

## 1. 배경 / 문제

직관 라이브의 신규 미디어는 전용 private 버킷에 처음부터 저장한다. 공개 여부는 storage 위치가 아니라
DB `status`로만 결정한다. 공개 트레이·뷰어는 active 행에 한해 서버 발급 signed URL을 사용하고,
경기 종료+24시간 뒤에는 이미 운영 중인 status-only archive가 `status='archived'`로 전환한다.

## 2. A안 결정 (근본 재설계)

**미디어를 처음부터 private 저장하고, 공개 트레이/뷰어(active)도 서버 발급 signed URL로 서빙한다.**
가시성은 **DB `status`만으로** 결정한다(공개=active, 비공개=archived). archive/복원은 **객체 이동 없이 status만 전환**한다.

### 2.1 저장 (private-first)
- venue story 전용 **private 버킷 `venue-media`**(public=false) 신설. 신규 미디어(사진·영상 원본·영상 포스터)는 처음부터 여기 저장.
- **격리**: videos/photos 는 움짤콜렉터/DM/아바타 등 타 기능도 공유 → 전체 private 화 금지. venue story 미디어만 전용 버킷으로 분리.
- 영상 원본 즉시검증 staging(`venue-staging`, private)은 유지. 검증 통과 원본을 **venue-media(public 아님)** 로 승격.
- DB 는 `media_bucket`/`media_path`/`thumb_bucket`/`thumb_path` 를 durable 기록(이미 존재하는 컬럼). 서빙은 이 bucket+path 기준.

### 2.2 공개 서빙 (signed URL + 캐싱)
- 공개 트레이·뷰어(active)는 서버(service_role)가 발급한 **signed URL** 로 미디어/썸네일을 서빙.
- **공개 mint allowlist**: `venue-media`만 허용. 검증 전 `venue-staging`은 active 오염이 있어도 공개 signed URL을 발급하지 않고 해당 story를 제외한다.
- **fail-closed**: private 참조의 서명 실패·경로 누락 시 `null`; 저장 `media_url`로 절대 폴백하지 않는다. 레거시 공개 버킷(videos/photos) 행만 저장 public URL을 그대로 사용한다.
- **짧은 공개 수명**: active signed URL TTL은 최대 5분이며 각 행의 `expires_at` 잔여시간 이하로 cap한다. 프로세스 캐시는 최대 4분이면서 effective TTL보다 짧고, 더 긴 기존 캐시는 재사용하지 않는다.
- admin 모더레이션은 검증 전 확인을 위해 `venue-staging` signed URL을 허용하되, 실패 시 동일하게 fail-closed한다.

### 2.3 archive (current main: status-only)
- PR #869부터 만료(경기 종료+24h) 시 cleanup은 **`status='archived'` 전환만** 수행한다(storage 객체 이동/삭제 없음). 공개면은 active만 노출하므로 자동 비공개.
- A1은 이 archive 로직과 다이어리 API를 변경하지 않는다.
- removed(신고/어드민/검증실패) 30일 격리, cleanup_failed/stale_cap 관제 정책은 유지(§ 아래 archive 정책 그대로, 단 객체 이동 없음).

## 3. 슬라이스 계획 (얇은 수직, 각 슬라이스 = 삼순 리뷰 게이트)

### A1 — 저장 private-first + 공개 signed URL 서빙 (본 슬라이스)
- **범위**: 신규 미디어를 venue-media(private)에 저장 + 공개 트레이/뷰어를 signed URL 로 서빙까지.
- migration: `venue-media` private 버킷(public=false, file_size_limit 50MiB, authenticated INSERT-own RLS) 신설(멱등). videos/photos/venue-staging 유지.
- 업로드: 사진·영상 포스터 → venue-media(client 직접, INSERT-own). 영상 원본 → venue-staging → 검증 통과 시 venue-media 로 승격.
- 서빙: GET `/api/venue-stories`(공개 트레이/뷰어) + admin 모더레이션이 private 버킷 미디어를 signed URL(캐싱)로 반환. 레거시 public 행은 그대로 public URL.
- 검증: 이미지/포스터 서버 probe 를 private 는 signed URL 로 수행. 720p 트랜스코드 산출물도 venue-media(private) 유지.
- orphan: `venue-media`를 기존 96시간 keyset/cursor 스윕에 포함. 전 status 참조집합이 active/archived 객체를 보호하고, list/remove fault 시 cursor를 전진시키지 않는다.
- **archive status-only·다이어리 API 무접촉**. cleanup route 변경은 orphan 스캔 버킷 편입에 한정한다.

### A2 — 다이어리 백엔드
- 다이어리 미디어 API: 본인 검증 + signed URL 로 archived+active 미디어 경기별 반환.
- 과거 경기 직접 추가: 로그인 본인이 **2026 시즌 종료(final) 경기**를 선택해 GPS 없이
  사진/영상을 추가할 수 있다. 서버가 실제 KBO 경기 상태, private storage 경로 소유권,
  이미지 MIME/크기와 영상 구조/길이를 검증한다.
- 직접 추가 미디어는 `attendance_source='diary_manual'`, `status='archived'`로 저장해
  공개 트레이·뷰어·댓글 작성면에는 단 한 번도 노출하지 않는다. 영상 검증 대기 중에도
  `pending`으로 비공개이며 검증 성공 시 `archived`로만 전환한다.
- 게임당 10개 상한은 active+pending+archived 전체를 advisory lock 안에서 원자적으로 센다.
  직접 추가 기록은 개인 다이어리 승·무·패/승률에는 포함하지만 GPS 인증 수치·채팅 배지와
  구분할 수 있도록 durable source를 API에 반환한다. 동일 경기의 기존 GPS 인증은 수동 기록으로
  절대 강등하지 않는다.
- current main의 status-only archive·removed 30일 격리·cleanup_failed·stale_cap 관제 계약을 그대로 사용한다.

### A3 — 레거시 데이터 이관 + 서빙 통일
- 기존 videos/photos 의 venue-stories 경로 객체를 venue-media 로 이관(백필) 후 `media_bucket`/`media_path` 갱신.
- 이관 완료 후 서빙에서 레거시 public URL 경로 제거(전면 signed URL 통일). videos/photos 의 venue-stories prefix 정리.

### A4 — 다이어리 UI (목록/캐러셀/삭제)
- `VenueDiaryCard` 보조 지표·`🔒 나만 보기`·경기 row 썸네일 6+N / 상세 캐러셀(순번·스와이프·도트) + 본인 삭제 + 읽기전용 댓글.

## 4. 레거시 호환 / 마이그레이션 전략

- **혼재 허용(A1~A2)**: 신규 행 = venue-media(private, signed), 레거시 행 = videos/photos(public URL). 서빙은 `media_bucket` 기준으로 자동 분기 → 두 세대 공존.
- **A3 백필**: service_role 워커가 videos/photos 의 venue-stories 객체를 venue-media 로 복사 → `media_bucket`/`media_path` 갱신 → 원본 삭제(검증 후). 멱등·재개 가능.
- **롤백 안전**: A1 은 신규 저장 경로/서빙만 바꾼다. 레거시 서빙·업로드 게이트·소유권 바인딩·검증 계약 불변 → 문제 시 신규 업로드만 영향, 공개면 회귀 없음.

## 5. 데이터 모델

- `venue_stories` 는 이미 `media_bucket`/`media_path`/`thumb_bucket`/`thumb_path`(durable)와 archive 컬럼(`archived_at`/`removed_at`/`cleanup_failed_at`, status `archived`)을 보유한다.
- `media_url TEXT NOT NULL` 유지: private 행은 getPublicUrl 형태 placeholder(서빙 미사용, bucket 기준 signed) 저장 → NOT NULL 충족.

## 6. archive 정책 (current main — status-only, 객체 이동 없음)

### 6.1 보관 전환 (정상 만료)
- `classifyCleanupRow` → `expired_after_end`(종료 확정 + 종료+24h 경과) 행은 **삭제/이동 없이 `status='archived'`** 전환.
- storage 원본(media/thumb) 보존(그 자리, venue-media). 댓글은 FK CASCADE 라 행 미삭제로 자동 보존.
- 공개면은 `status='active'` 만 노출 → archived 자동 제외 = "하루 뒤 비공개".

### 6.2 삭제 유지 대상 (다이어리 미보관)
- **removed**(신고 임계/어드민/검증실패): 즉시 영구삭제 금지 → 30일 격리 후 삭제(오신고 복구 여지). `removed_at` 기준.
- **cleanup_failed / stale_cap**: 장애 상태 → 즉시 auto archive/delete 금지, 격리+관제. `cleanup_failed` 는 `removed_at IS NOT NULL` 일 때만 removed 출신 확정해 30일 격리 후 삭제 재시도, `cleanup_failed_at`+7일 영구실패 TTL 경과 시 행 삭제 강제. `removed_at IS NULL` = 출신 불명 → auto 없이 격리+5xx 관제.
- **orphan S1 예외**: DB 참조 0건 + 생성 96h 경과 + 참조조회 오류 시 전체 스캔 skip + 삭제 오류 시 5xx·cursor 미전진 객체만 대상 → 기존 즉시삭제 유지.

### 6.3 보관 기한 / 접근 제어
- 계정 유지 중 무기한 보관. 삭제 트리거: 본인 삭제 / 탈퇴(FK CASCADE) / 법적·운영 삭제.
- 다이어리 = 본인 소유만. service_role API + `getVerifiedUserFromRequest` 본인 검증(공개 RLS 없음). signed URL 로 서빙.
- 비용 가드: 월별 저장량·증가율·비용 임계 알림 훅(출시 조건).

## 7. 검증 기준 (Goal-Driven)

- **A1**: private 서명 실패·경로 누락 fail-closed, 공개 venue-staging mint 차단, active TTL 5분/`expires_at` cap/캐시 안전성, venue-media orphan 96시간 스윕과 참조 보호 회귀. 실동선: 업로드→venue-media(private) 저장→공개 트레이 signed URL 노출→뷰어 재생 정상, 레거시 public 행 병존, 타 기능 버킷 무영향.
- **A2**: current main status-only archive의 원본·댓글 잔존을 유지하고, archived 다이어리 API
  노출을 검증한다. owner-only/2026 final-only/GPS 불필요, 타인 경로·예정·진행·취소 경기 거부,
  직접 추가 source 반환, 공개면 0, active+pending+archived 동시성 상한 10을 회귀로 고정한다.
  상세 댓글 작성자 profile은 UUID 100개 단위로 분할 조회해 10 story×100 unique commenter에서도
  PostgREST URL/필터 한도를 넘지 않고, 한 batch 실패 시 상세 전체를 fail-closed한다.
- **E2E(A4)**: 실 로그인 유저가 어제 스토리 업로드 → 24h 후 공개 트레이 미노출 + `/my` 다이어리 열람 + 본인 삭제.
- **Surgical / 회귀 0**: 공개 스토리/트레이/업로드/재생 경로 회귀 0 최우선.
