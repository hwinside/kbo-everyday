# KBO ↔ Naver 완전 이중화(Full Dual-Source Fallback)

작성: 삼식이 / 2026-07-29 / 트리거: 하린아빠 "일단 2중화 fallback 구조는 완벽히 갖추어놓자"

## 배경 / 문제

KBO API(`GetKboGameList`, `Record/*.aspx`, `Player/Register.aspx`)가 2026-07-28부터 이중 열화
(END_TM/이닝셀 결측 + `kbo-games` 타임아웃). KBO가 완전히 다운되어도 앱 전 기능이 Naver로
자동 대체되도록 "완벽한 이중화"를 갖춘다.

## 현재 소스 계층 (2026-07-30 실측 감사)

이미 이중화됨:
- 순위표 `fetchStandings` — **Naver primary + KBO HTML 폴백** ✅
- 라이브 이닝점수/박스스코어 (`game-detail`, `game-events`) — KBO primary + Naver record 폴백.
  단, `game-detail`은 KBO 3종과 후속 경기목록 await가 timeout 없이 누적되어 기존 폴백 도달 전
  40초 이상 지연되는 availability gap이 남아 있음 ← **P0 bounded hardening 대상**
- 중계 pitch-by-pitch(`game-relay`), AI요약, 뉴스 — Naver 계열 ✅

아직 KBO 단일 (이번 작업 대상 갭):
- 유저 대면 경기목록은 Naver-primary + KBO enrich로 이중화 완료. cron/배치 `fetchGames`는
  시리즈 계약 보존을 위해 KBO-primary + Naver fallback 유지.
- `fetchGameDates` — 이전/다음 경기일 (KBO `GetKboGameDate` 전용)
- `fetchBatterStats` — 선수 타격 랭킹 (KBO HTML 파싱 전용)
- `fetchRegisterRosters` — 1군 엔트리 등록/말소 (KBO WebForms 전용)

## Naver 대응 엔드포인트 (실현성 확인)

- 일정+스코어+상태: `GET api-gw.sports.naver.com/schedule/games?upperCategoryId=kbaseball&categoryId=kbo&fromDate=&toDate=` — 실측 OK (2026-07-29 5경기 정상). gameId `20260729HTSS02026`(reversed home/away + 연도 suffix), `statusCode`(READY/STARTED/RESULT/CANCEL...), `homeTeamScore/awayTeamScore`, `cancel`, `suspended`, `reversedHomeAway`.
- 순위: `statistics/.../teams` — 이미 사용 중.
- 선수기록: `statistics/categories/kbo/seasons/{y}/players?...` (배터 랭킹) — 슬라이스③에서 shape 확정.
- 엔트리: Naver는 팀별 라인업/엔트리 endpoint 제공 — 슬라이스④에서 shape 확정(대체 난이도 최상, WebForms 대비 구조 완전 상이).

## 설계 원칙

1. **KBO primary 유지, Naver는 폴백** (단, 순위표는 이미 Naver-primary라 그대로). KBO가 살아있을 때 동작/스키마 변화 0 — surgical.
2. **단일 fallback 래퍼**: 각 `fetchX()`를 `try KBO → catch → trackFallback → Naver 대체 → 그래도 실패면 throw` 형태로. `trackFallback`(#941 경보 원장)에 소스 전환 기록.
3. **gameId 매핑 레이어**: Naver reversed gameId ↔ KBO gameId 순수 변환 함수(양방향), 올스타/더블헤더 케이스 포함. `game-detail`의 `naverGameId()` 재사용/일반화.
4. **graceful degradation**: 폴백은 리스트-레벨 필드(스코어/상태/이닝) 보장. 라이브 카운트(strikes/balls/outs/runners/currentBatter)는 Naver schedule에 없음 → 폴백 시 0/빈값(상세·중계 Naver 경로가 in-game 상태 커버). 스펙에 명시.
5. **fail-closed sanity**: Naver 응답도 `success/code` + 경기수/팀 sanity 검증 후 채택. 빈/부분 응답을 성공으로 묻지 않음(#941, roster sanity 선례).

## 슬라이스 (얇은 수직, 각 PR = 삼순 리뷰 게이트)

- ① `fetchGames` Naver 폴백 + 유저 대면 Naver-primary 하이브리드 — 완료
- ①.6 `/api/game-detail` 단일 3초 절대 deadline + Naver record/list 병렬 fallback — **P0**
- ② `fetchGameDates` Naver 폴백
- ③ `fetchBatterStats` Naver 폴백
- ④ `fetchRegisterRosters` Naver 폴백 (난이도 최상)

## 검증 기준 (각 슬라이스 공통 DoD)

- KBO 정상 시 기존 동작·스키마 무변화 회귀 테스트(폴백 미발동).
- KBO 강제 실패(mock throw/timeout) 시 Naver 폴백이 동일 형태 반환하는 실행형 테스트.
- Naver 빈/부분 응답 fail-closed 테스트.
- gameId 매핑 양방향(정규/올스타/더블헤더) 순수 테스트.
- `qa:query-guard`/tsc/eslint 0, Vercel prebuild PASS.
- 배포 후 실제 라이브 경기에서 폴백 강제(또는 자연 열화) 시 리스트 정상 노출 End-User 확인.

### ①.6 추가 회귀

- committed actual `GET /api/game-detail`: KBO blackhole/Naver 정상, 역방향, KBO 부분 스키마,
  양쪽 blackhole, srId 0→1 retry, HTTP 오류를 동일 절대 deadline으로 검증.
- KBO unavailable이면 `lineup=null`, Naver linescore·boxScore·status는 유지하고 HTTP 200 partial.
- 정상 scheduled/cancelled의 이닝·박스 부재는 관제 0건, live/final 결측과 dual outage만
  실제 reason(timeout/HTTP/schema)을 보존해 비차단 관제.
- route에 후속 `fetchGames()` 기본 10초 await가 재유입되면 mutation guard가 즉시 실패.
