# 홈 최애선수 카드 — 최근 추이 전환 v1

## 배경 / 문제
홈 최애선수 카드가 **시즌 누적** 스탯(타율/HR·타점/OPS, ERA/승패세/이닝K)만 보여줘
매일 봐도 값이 거의 안 변함 → 고객 피드백 "메인에 항상 뜨는 게 굳이?" (#cs 2026-06-17).
근본 원인은 "노출 위치"가 아니라 **정보가치(매일 볼 이유)** 부재.

## 결정 (하린아빠 2026-06-17)
숨기지 말고 카드를 **풍부하게** 바꾼다:
1. **최근 출전 3경기 평균** (타자=타율 / 투수=ERA)
2. **주차별 그래프** (압축 스파크라인)
3. **전주 대비 상승/하락 아이콘**

## 스펙
- **헤드라인**: 최근 출전 3경기 평균.
  - 타자 = ΣH/ΣAB (`.324` 표기), 투수 = ΣER·27/Σouts (`2.45` 표기).
  - "출전 경기"만 — game-logs API가 이미 무출전 경기 제외(`didPlay`).
- **추세 아이콘**: 주간 시계열 마지막 두 주 비교.
  - 타자 타율↑ = 개선(▲ 초록) / 투수 ERA↓ = 개선(▲ 초록). 악화 ▼ 빨강, 동일 – 회색.
  - 2주 미만이면 아이콘 생략.
- **미니 스파크라인**: 주간 타율/ERA 추이(축·툴팁 없는 36px). 투수는 Y축 reversed(낮을수록 위, 상세 차트와 일치). 2주 이상부터 노출.
- **시즌 누적**: 헤드라인 아래 한 줄 작게 **보조 유지**(완전 제거 아님). 타자 `시즌 .XXX · N홈런 N타점`, 투수 `시즌 X.XX · N승 N패 N세`.
- **폴백**: 최근 3경기 데이터 없으면 → 시즌 누적을 헤드라인으로(아이콘/스파크라인 없이). 둘 다 없으면 "2026 시즌 기록 준비 중".

## 데이터 / 재사용
- 신규 API 0. 기존 `/api/player-stats`(시즌) + `/api/player-game-logs`(경기 로그, asc·출전만) 사용.
- 주간 집계 로직은 선수 상세 `PlayerWeeklyTrend`에서 `src/lib/stats/weekly-trend.ts`로 **공용 추출**
  (`weekOf` / `toWeeklyTrend` / `recentAverage` / `weeklyDirection`) → 홈 카드와 상세 페이지 수치 일치 보장.

## 변경 파일
- `src/lib/stats/weekly-trend.ts` (신규, 공용 집계)
- `src/components/home/MiniTrendSparkline.tsx` (신규, 압축 스파크라인)
- `src/components/home/FavoritePlayersSection.tsx` (카드 본문 전환 + game-logs fetch)
- `src/components/player/PlayerWeeklyTrend.tsx` (공용 모듈 import로 교체, 동작 동일)

## 검증
- tsc / eslint clean.
- End-User QA: 최애선수 설정한 실유저 홈 → 카드에 최근3경기/스파크라인/추세아이콘 노출,
  값이 선수 상세 주간추이와 일치, 데이터 부족 선수는 graceful 폴백.
