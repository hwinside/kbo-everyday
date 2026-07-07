-- 1.0.7 풀 카드 버전 게이트 — 토큰 등록 시 앱 빌드 번호를 기록한다.
-- null/구빌드(<11) 토큰엔 슬림 payload(투수/타자·lastPlay 제외), 11+엔 풀 payload.
-- 배경: 2026-07-07 인시던트 — 1.0.6 이하 익스텐션은 풀 라이브 프레임 렌더가 예산 초과로
-- 간헐 실패(스피너). 빌드별 payload 분기로 구버전 회귀 없이 신버전만 풀 카드 복원.
alter table live_activity_tokens add column if not exists app_build int;
