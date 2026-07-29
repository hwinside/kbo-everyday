# 야구천재 seed 132개 근거 전수 검수 — 2026-07-30

## 판정 기준

- `official_rule`: KBO 경기규칙·2026 규칙 변화·경기운영제도에 직접 대응한다.
- `official_record`: KBO 공식 타자/투수 기록실의 기록 항목에 직접 대응한다.
- `editorial_definition`: KBO 공식 페이지가 정의 근거가 아닌 문화·전술·구종·세이버 설명이다.
  공식 규정처럼 표시하지 않으며 `source_url=NULL`, `rule_version=not_applicable`로 저장한다.

## 실제 근거 매핑

- 경기규칙: https://www.koreabaseball.com/Reference/Etc/GameRule.aspx
- 2026 변경 규칙: https://www.koreabaseball.com/Kbo/League/GameManage2026.aspx
- 경기운영제도: https://www.koreabaseball.com/Kbo/League/GameManageRule/GameManage.aspx
- 타자 기록: https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx
- 투수 기록: https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx

## 편집 설명으로 분리한 26개

스퀴즈, 히트앤런, 클린업, 테이블세터, 리드오프, 불펜, 마무리투수, 유틸리티,
퀄리티스타트, 블론세이브, wRC+, WAR, WHIP, 포심, 투심, 슬라이더, 커브,
체인지업, 포크볼, 커터, 너클볼, 언더핸드, 클러치, 스윕, 위닝시리즈,
벤치클리어링.

실제 분류 개수는 고정 문자열이 아니라 migration을 PGlite에 적용해 검증한다.
`official_rule + official_record + editorial_definition = 132`, 공식 항목 URL 필수,
편집 설명 URL 금지, 공식 URL 종류 4개 이상을 `qa:baseball-qa`가 회귀 고정한다.

## 2026 변경사항 직접 대조

- 수비 시프트: 위반 제재 반영
- 엔트리: 29명 등록·28명 출장 반영
- 외국인 선수: 기존 외국인 3명 외 아시아쿼터 1명 반영
- ABS·피치클락·체크스윙: 2026 변경 규칙 페이지로 별도 매핑

검수 대상 132개 term과 최종 분류는
`supabase/migrations/20260730_baseball_qa_seed.sql`의 seed/CASE가 단일 원본이다.
