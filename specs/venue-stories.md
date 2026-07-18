# 직관 라이브 (Venue Stories) — Spec

> 상태: Slice 1 (MVP) 구현. 2026-07-18 하린아빠 "만들자" + "직관 스토리 MVP좋다" 승인.
> 출처: #product 두엘방 아이디어 — 현장(직관) 팬이 짧은 클립/사진을 올리면 경기 카드 밑에서
> 스토리처럼 넘겨보는 "직관 라이브 중계" (NBA/티빙 현장 느낌).

## 컨셉

직관 온 팬이 경기별로 짧은 세로 클립(≤15초)/사진 업로드 → 경기 상세 하단 "직관 라이브"
섹션에서 스토리처럼(인스타/NBA) 탭으로 넘겨봄 → 경기 끝나면 자동 삭제(서버비 절약).

## Slice 1 (이번 PR) 범위

- 경기 상세(`games/[gameId]`) 하단 "직관 라이브" 스토리 트레이 + 풀스크린 뷰어
- 로그인 유저가 해당 gameId 에 세로 클립(≤15초)/사진 업로드 — 지오펜스 없이 경기방 유저 누구나
- 업로드 미디어 상한: 영상 ≤15초 / 파일 ≤60MB, 사진은 기존 클라 압축(1200px JPEG) 재활용
- 경기 종료(=업로드 +8h TTL) 후 자동 만료 삭제 (cron `venue-stories-cleanup`)
- 신고 + 임계치(3건) 자동 숨김 + 본인 삭제 (App Store/Play UGC 모더 요건 충족)

## 2차(별도 트랙, 이번 제외)

- 지오펜스: GPS 구장 반경 안에서만 업로드 허용 (직관 인증)
- AI 하이라이트 자동 취합: 경기 클립들을 하나의 영상으로 스티칭
- 지승규님 스티커/꾸밈 요소 오버레이
- 영상 트랜스코딩 워커 연동(현재 MVP는 원본 서빙 — 짧고 자동만료라 감당)

## 데이터 모델

`venue_stories` (신규 테이블, service_role 전용 — 클라 RLS 정책 없음, video_transcode_jobs 패턴)
- 미디어는 클라가 기존 storage 버킷(`videos`/`photos`)에 직접 업로드(버킷 RLS = authed insert)
- 행 생성/조회/신고/삭제/정리는 전부 API route(admin client) 경유 → expires_at·검증 서버 권위

주요 컬럼: game_id, user_id, media_type(video|image), media_url, media_bucket, media_path,
thumb_url, thumb_path, duration_ms, width, height, caption, report_count, status(active|removed),
created_at, expires_at.

## API

- `GET  /api/venue-stories?gameId=`  — active·미만료 스토리 목록 + 작성자 프로필(admin join)
- `POST /api/venue-stories`          — 생성(verified user): 미디어 URL 소유 검증·duration 검증·
                                        게임당 유저 상한(10)·expires_at 서버 세팅
- `POST /api/venue-stories/report`   — 신고(verified): reports 테이블(target_type=venue_story) +
                                        report_count++ , ≥3 이면 status=removed 자동 숨김
- `DELETE /api/venue-stories/[id]`   — 본인 삭제(verified): 스토리지 오브젝트 + 행 제거
- `GET  /api/cron/venue-stories-cleanup` (Bearer CRON_SECRET) — 만료·removed 스토리지+행 정리

## UI

- `VenueStorySection` — 경기 스코어보드 밑(탭 위)에 배치. 가로 트레이(＋올리기 + 썸네일 링).
- `VenueStoryComposer` — 업로드 모달(카메라/갤러리, 영상 15초 검증, 포스터 썸네일 생성, 캡션).
- `VenueStoryViewer` — 풀스크린 스토리 뷰어(상단 진행바, 탭 넘김, 자동 진행, 신고/삭제).

## 검증(Definition of Done)

- tsc 신규 에러 0 / eslint 0
- 영상 15초 초과·60MB 초과 업로드 거부(클라) + 서버 duration 재검증
- 만료 cron 로컬 dry 확인(만료 행 select 카운트)
- 배포 후 End-User QA: 경기방에서 업로드 → 트레이 노출 → 뷰어 재생 → 신고/삭제 → 만료 정리
