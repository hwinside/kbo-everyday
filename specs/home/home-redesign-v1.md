# 홈 개편 v1 — 팀 카드 신설 + 뉴스 썸네일 + 섹션 순서/토글

**Slack thread:** #product 1781717480.132009 (2026-06-18)
**Owner:** 삼식이
**Status:** 스펙 확정(하린아빠 "go" 2026-06-18) → 슬라이스 착수

## 배경 / 결정 (하린아빠 2026-06-18)
홈을 3가지로 개편한다.
1. **뉴스 카드 썸네일** — 좌측 사진 썸네일 + 제목 우측 이동(클릭율↑). 현 디자인 유지.
2. **팀 카드 신설** — 최애선수 카드처럼, 최애팀 최신 사항 요약 카드.
3. **섹션 순서 재배치 + 마이페이지 섹션 on/off**.

## 1. 뉴스 카드 썸네일
- 대상: 홈 `NewsCarousel`(`src/components/news/NewsCarousel.tsx`). (팀 뉴스탭은 `news-thumbnail-og.md`에서 이미 적용 — API의 og:image 추출 로직 재사용)
- 레이아웃: 현 카드 유지 + **좌측 썸네일 / 제목·메타 우측**. 썸네일 = 기사 og:image.
- **이미지 없을 때 = 현행과 완전히 동일하게 노출**(폴백 플레이스홀더 안 만듦 — 하린아빠 확정).
- 구현 확인: 홈 뉴스 소스(`/api/news/batch` 또는 `realNews`)가 `thumbnailUrl`을 싣는지 확인. 안 실으면 팀뉴스탭과 동일한 `attachThumbnails` 경로 재사용.

## 2. 팀 카드 (최애팀, v1)
최애선수 카드 패턴(`FavoritePlayersSection`) 재사용. 항목:
- **a. 현재 순위 + 게임차** — 상위/하위 팀과의 게임차.
- **b. 연승/연패 기록** — streak.
- **최근 5경기 폼** — ●○●●○ 도트(승=채움/패=빈/무=중립). b보다 정보량 큼.
- **c. 다음 예정 경기** — 양 팀 **예고 선발 매치업** + **예정 경기 페이지로 가는 CTA**(삼순 제안).
- **d. 시즌 순위 변동 그래프** — 일별 순위 추이(압축 스파크라인, 낮은 순위=위).
- **e. 1군 로스터 추가/삭제 선수 명단** — 최근 엔트리 변동.
- **f. 순위권 선수** — 타자/투수 부문별 상위 5위 이내 최애팀 선수 명단.
- (v2 후보: 팀 시즌 스탯 요약 / 팀 화제글 / 매직넘버 — 이번엔 제외)

### 데이터 소스
- **a/b/d**: `daily_standings_snapshot` 테이블 (date·team_id PK, rank·wins·losses·draws·win_rate·games_behind·streak). **2026-04-15부터 매일 16시(KST) cron 적재 중**.
  - **개막~4/14 공백 = 백필로 메움 (하린아빠 2026-06-18 "개막부터 보여줘")**. KBO API는 "특정 날짜 순위"는 안 주지만 **과거 날짜의 최종 경기 결과(점수·승패)는 반환함**(`GetKboGameList(date)` 검증 완료: GAME_STATE_SC=3 final, T/B_SCORE_CN). → **개막일부터 매일 전체 경기 결과를 순서대로 replay → 누적 W/L/D → 일별 순위·게임차·streak 재구성**해 누락 날짜에 insert. 1회성 backfill 스크립트.
  - 정확성 검증: replay를 4/15까지 돌려 stored 4/15 스냅샷(wins/losses/rank)과 대조 → 일치하면 backfill 신뢰. 동률일 tiebreak edge case는 그래프 영향 미미.
- **c 다음경기/예고선발**: `fetchGames(date)` (`T_PIT_P_NM`/`B_PIT_P_NM` 예고선발, `T_RANK_NO`/`B_RANK_NO`). 향후 일정 조회.
- **e 로스터 변동**: roster-guard가 박스스코어 미등록 선수 감지 중 → 엔트리 변동 diff 소스 **구현 시 확인**(daily roster diff 저장 여부).
- **f 순위권 선수**: `daily_stats_snapshot` (date·category[avg/hr/rbi/sb/era/wins/k/saves/whip]·rank·player_name·team·value) → 최애팀 선수 중 rank≤5 필터.
- **최근 5경기 폼**: 팀 단위 최근 경기 결과 소스 **구현 시 확인** — `player_game_logs`(game_id·game_date·team_id·result W/L/D, 6/6~)로 팀별 distinct game 역산 or `fetchGames` 일자별. S3에서 확정.

## 3. 섹션 순서 + 마이페이지 on/off
**목표 순서**: 팀카드 → 뉴스카드 → 경기카드(MyTeamHero) → 최애선수카드 → 숏츠슬롯 → 전체경기현황(LiveGameBanner+TodayGames).
- 현재 순서: 뉴스 → WhatsNew → MyTeamHero → 최애선수+숏츠 → LiveGameBanner → TodayGames.
- **on/off 저장**: 기존 숏츠 토글(`src/lib/store/shorts-pref.ts`, localStorage + 이벤트) 패턴을 **섹션별 키로 일반화**(`home-sections-pref.ts`). 기본 전부 ON. 기기 로컬(서버/마이그 0).
- 마이페이지: 기존 `ShortsToggleCard`를 섹션 토글 묶음(`HomeSectionsCard`)으로 확장 — 팀/뉴스/경기/최애선수/숏츠/전체현황 6개 스위치. 숏츠 키 하위호환 유지.
- WhatsNewCard·EventBanner·퀵액션(티켓/구장)은 토글 대상 아님(현 위치 유지).

## 슬라이스 (각 = PR → 삼순 GO → 하린아빠 승인 → 머지 → End-User QA)
- **S1. 뉴스 카드 썸네일** — 소·가시성↑. 가장 안전.
- **S2. 섹션 순서 재배치 + 마이페이지 토글 프레임워크** — `home-sections-pref` 일반화 + 6섹션 토글. (팀카드는 아직 없으니 5섹션 reorder, 팀카드 슬롯은 S3에서 삽입)
- **S3. 팀 카드 기본** — 카드 셸 + a 순위/게임차 · b 연승연패 · 최근5경기 폼 · c 다음경기+예고선발+CTA. 순서 최상단 삽입 + 토글 연결.
- **S4. 팀 카드 d 순위변동 그래프** — (1) 개막~4/14 backfill 스크립트(일별 경기결과 replay → 스냅샷 insert, 4/15 대조 검증) + (2) `daily_standings_snapshot` 전구간 시계열 스파크라인.
- **S5. 팀 카드 e 로스터 변동 + f 순위권 선수**.

## 검증
- 슬라이스별 tsc/eslint clean.
- End-User QA: 최애팀/최애선수 설정 실유저 홈에서 각 섹션 정상 + 마이페이지 토글 on/off 즉시 반영 + 팀 카드 데이터가 standings/stats 페이지와 일치.
- 머지 게이트 시퀀스 준수(AGENTS.md): 삼순 GO → 하린아빠 승인 → 머지.
