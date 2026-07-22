# 직관 라이브 (Venue Stories) — Spec

> 상태: Slice 1 (MVP) 구현. 2026-07-18 하린아빠 "만들자" + "직관 스토리 MVP좋다" 승인.
> 2026-07-18 하린아빠 "지오펜스는 바로 적용" → 지오펜스를 Slice 1 필수로 편입.
> 출처: #product 두엘방 아이디어 — 현장(직관) 팬이 짧은 클립/사진을 올리면 경기 카드 밑에서
> 스토리처럼 넘겨보는 "직관 라이브 중계" (NBA/티빙 현장 느낌).

## 컨셉

직관 온 팬이 경기별로 짧은 세로 클립(≤15초)/사진 업로드 → 경기 상세 하단 "직관 라이브"
섹션에서 스토리처럼(인스타/NBA) 탭으로 넘겨봄 → 경기 끝나면 자동 삭제(서버비 절약).

## Slice 1 (이번 PR) 범위

- 경기 상세(`games/[gameId]`) 하단 "직관 라이브" 스토리 트레이 + 풀스크린 뷰어
- 로그인 + **직관 인증(지오펜스)** 통과 유저만 해당 gameId 에 세로 클립(≤15초)/사진 업로드 (조회는 누구나)
- **지오펜스(필수)**: 서버가 gameId → 실제 경기 스케줄의 개최 구장(`S_NM`) 좌표를 독립 해석해
  GPS 반경 안에서만 업로드 허용. 기본 700m·대형 구장 최대 1km·accuracy ≤300m. 위치 권한 거부/범위 밖/
  저정확도/미매핑 구장/시간대 밖/없는·가짜 gameId 는 전부 **fail-closed**(업로드 차단).
  네이티브 GPS(@capacitor/geolocation, When-In-Use 권한) 실제 등록(capacitor 플러그인 생성 파일 커밋).
  구버전 앱은 플러그인 미지원 감지 → "앱 업데이트 필요" 명시 안내(fail-closed).
- 업로드 미디어 **서버 권위 검증**: 소유 경로 바인딩(`venue-stories/{gameId}/{userId}/`, canonical URL 정규화 후 exact key) +
  객체 실제 존재·크기(≤50MiB, Supabase Storage 전역 상한과 일치, maxBytes 선제 cancel)·매직바이트 확인.
- **검증 후 즉시 노출(B+①, 하린아빠 확정 2026-07-21)**: 영상은 private staging의 `pending`으로 저장해 목록·URL에서 숨기고,
  같은 업로드 요청에서 서버 ffprobe(구조·≤15초)를 통과한 뒤에만 공개 버킷 게시 + `active` CAS 승격.
  fault는 `pending` 유지, 거부는 `removed` 처리한다. GitHub Actions Ubuntu 워커는 30분 복구·720p 최적화만 담당한다.
  사진은 기존 클라 압축(1600px JPEG) 후 `active`.
- **업로드 마감과 만료 분리(하린아빠 스펙 2026-07-20)**: 업로드 가능=경기 시작 -60min~+6h.
  만료(자동삭제)=**경기 종료 +24h**. 종료 전에는 시작+72h 장애 안전상한(정상 만료 조건 아님) →
  finalize cron `venue-stories-finalize`(라이브 시간대 10분)이 진행중→종료(final/cancelled) 전이를 감지해
  `game_ended_at` 확정 → 만료=종료감지+24h 로 재설정(감지 오차 ≤10분). KBO 피드에 종료 정확시각이 없어
  종료 감지 시각을 종료 근사로 쓴다.
  cron `venue-stories-cleanup`(2시간): storage 먼저 제거 후 행 삭제, 실패 시 `cleanup_failed` 재시도 +
  orphan bucket별 **durable cursor + 전구간 페이지네이션**(starvation/fault 방지, fault는 cursor 유지+5xx).
- **UGC 동의(versioned)**: 업로드 시 `consentVersion` 전송, 서버가 현재 버전 이상만 허용(device-local 아님) +
  행에 `consent_version`/`consent_at` audit 기록. 문구 변경 시 버전 증마로 재동의 강제.
- **최애팀 라벨**: 트레이 썸네일 compact 배지 + 뷰어 작성자 full 라벨(author.teamId). 댓글 라벨과 댓글 기능은 Slice 2.
- 신고 원자 처리(DB RPC insert+증가+임계 3건 자동 숨김 한 트랜잭션) + 어드민 즉시 내림(`/admin/venue-stories`)
  + 차단 유저 콘텐츠 필터 + 본인 삭제 (App Store/Play UGC 모더 요건 충족).

> ⚠️ **지오펜스 한계(명시)**: 좌표는 클라이언트 입력이라 서버 거리 재계산은 tamper-proof 인증이 아닌
> soft geofence 다. 조작 가능성은 신고/어드민 내림으로 사후 대응한다. hard 인증(서버발급 위치 토큰 등)은 2차.
> ⚠️ **인앱 GPS 유효 시점**: Geolocation 플러그인+권한이 들어간 **새 iOS/Android 빌드 스토어 배포 후**부터
> 네이티브 인앱 위치가 동작(웹은 즉시). 머지 후 vc bump 빌드 + 실기기 QA 필요.

## 2차(별도 트랙, 이번 제외)

- AI 하이라이트 자동 취합: 경기 클립들을 하나의 영상으로 스티칭
- 지승규님 스티커/꾸밈 요소 오버레이
- hard 위치 인증(서버 발급 단기 위치 토큰 등 tamper-proof)

## 데이터 모델

`venue_stories` (신규 테이블, service_role 전용 — 클라 RLS 정책 없음, video_transcode_jobs 패턴)
- 미디어는 클라가 기존 storage 버킷(`videos`/`photos`)의 *본인 예약 경로*(`venue-stories/{gameId}/{userId}/`)에
  직접 업로드(버킷 RLS = authed insert), 생성 API 가 경로 prefix=업로더 소유를 강제해 타인 미디어 참조·삭제 차단
- 행 생성/조회/신고/삭제/정리는 전부 API route(admin client) 경유 → expires_at·검증 서버 권위

주요 컬럼: game_id, user_id, media_type(video|image), media_url, media_bucket, media_path,
thumb_url, thumb_path, duration_ms, width, height, caption, venue_verified, stadium_name,
report_count, transcode_attempts, status(pending|active|removed|cleanup_failed), created_at, expires_at.

## API

- `GET  /api/venue-stories?gameId=`  — active·미만료 스토리 목록 + 작성자 프로필(admin join, 차단 유저 제외)
- `GET  /api/venue-stories/venue?gameId=` — 클라 지오펜스 프리체크(구장 좌표·반경·업로드 가능 시간대)
- `POST /api/venue-stories`          — 생성(verified): 소유 경로 바인딩·gameId→실제 경기/구장/시간 fail-closed·
                                        지오펜스(lat/lng/accuracy 필수) 재검증·객체 크기(maxBytes 선제)/매직바이트 검증·
                                        UGC 동의 버전 정확일치 검증·게임당 유저 상한(10, RPC advisory lock)·
                                        영상 pending / 사진 active·expires_at(시작+30h 근사치) 서버 세팅
- `POST /api/venue-stories/report`   — 신고(verified): DB RPC(reports insert + report_count++ + ≥3 자동 숨김) 원자 처리
- `DELETE /api/venue-stories/[id]`   — 본인 삭제(verified): 소유 재검증 후 스토리지 오브젝트 + 행 제거
- `GET  /api/admin/venue-stories` · `POST` (admin PIN) — 모더레이션 목록 + 즉시 내림(status=removed)
- `GET  /api/cron/venue-stories-cleanup` (Bearer CRON_SECRET) — 만료·removed·cleanup_failed·orphan 정리
- `scripts/transcode-videos.mjs` (Mac mini) — pending 영상 ffprobe 재검증 + 720p 인코딩 → active/removed

## UI

- `VenueStorySection` — 경기 스코어보드 밑(탭 위)에 배치. 가로 트레이(＋올리기 + 썸네일 링).
- `VenueStoryComposer` — 업로드 모달. 열릴 때 `/venue` 프리체크로 업로드 가능 시간대/구장 안내, 제출 시
  getVenuePosition(네이티브 GPS) → 반경 게이트 → 미디어 준비 → POST(lat/lng/accuracy). 서버가 최종 권위.
- `VenueStoryViewer` — 풀스크린 스토리 뷰어(상단 진행바, 탭 넘김, 자동 진행, 신고/삭제).

## 검증(Definition of Done)

- tsc 신규 에러 0 / eslint 0
- 영상 15초 초과·50MiB 초과 업로드 거부(클라) + 서버 ffprobe duration/크기 재검증(검증 완료 전 비노출)
- 지오펜스 단위 테스트: 실제/제2구장/중립·올스타/가짜 경기 × inside/outside/저accuracy/권한거부 → fail-closed
- 만료 cron 로컬 dry 확인(만료 행 select 카운트) + cleanup_failed 재시도·orphan 스캔
- 배포 후 End-User QA: 경기방에서 업로드 → 트레이 노출 → 뷰어 재생 → 신고/삭제 → 만료 정리
