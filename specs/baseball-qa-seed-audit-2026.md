# 야잘알봇 seed 132개 근거 전수 검수 — 2026-07-30 (삼순 3차 P1 반영 재검수)

## 판정 기준 (항목별 실정합)

- `official_rule`: 야구규칙서 범위의 경기 규칙/기록 규정. KBO 경기규칙 페이지에만 연결한다.
- `official_record`: KBO 공식 타자/투수 기록 페이지에 **실제 컬럼으로 존재하는 스탯**만.
  항목별로 해당 컬럼이 실리는 페이지(Basic1/Basic2)에 정확히 연결한다.
- `editorial_definition`: 위 두 범주로 검증 가능한 URL이 없는 항목은 공식 규정처럼
  표시하지 않고 `source_url=NULL`, `rule_version=not_applicable`로 정직하게 분리한다.
  - 본문이 이미지 1장뿐인 `GameManage.aspx`(경기운영제도)와 근거 본문을 확인할 수 없는
    `GameManage2026.aspx`는 **근거 URL로 사용하지 않는다** (3차 리뷰에서 오매핑 판정).

## 실제 근거 매핑 (사용 URL 5종)

- 경기규칙: https://www.koreabaseball.com/Reference/Etc/GameRule.aspx
- 타자 기록 Basic1 (AVG/R/RBI): https://www.koreabaseball.com/Record/Player/HitterBasic/Basic1.aspx
- 타자 기록 Basic2 (OBP/SLG/OPS/RISP/MH): https://www.koreabaseball.com/Record/Player/HitterBasic/Basic2.aspx
- 투수 기록 Basic1 (ERA/ER/SV/HLD): https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic1.aspx
- 투수 기록 Basic2 (CG/SHO): https://www.koreabaseball.com/Record/Player/PitcherBasic/Basic2.aspx

## 편집 설명으로 분리한 항목

- 문화·전술·세이버·구종/폼 26개(기존): 스퀴즈, 히트앤런, 클린업, 테이블세터, 리드오프,
  불펜, 마무리투수, 유틸리티, 퀄리티스타트, 블론세이브, wRC+, WAR, WHIP, 포심, 투심,
  슬라이더, 커브, 체인지업, 포크볼, 커터, 너클볼, 언더핸드, 클러치, 스윕, 위닝시리즈,
  벤치클리어링.
- 서사적 기록 명칭 5개(3차 추가 — 기록 페이지 컬럼이 아님): 노히트노런, 퍼펙트게임,
  사이클링히트, 사이클링히트 조건, 승률.
- KBO 2026 리그 운영/특별규정 3개(3차 추가 — 공개 규정 본문 URL 미확보): 체크스윙,
  시프트, 비디오판독.
- `category='league'` 전체 23개(3차 추가 — GameManage.aspx 오매핑 정직 분리): FA,
  신인드래프트, 샐러리캡, 골든글러브, MVP, 신인왕, 엔트리, 등록말소, 외국인선수,
  퓨처스리그, 트레이드, 웨이버, ABS, 피치클락, 더블헤더, 우천취소, 매직넘버, 올스타전,
  와일드카드결정전, 준플레이오프, 플레이오프, 한국시리즈 등.

## 회귀 고정 (`qa:baseball-qa`)

실제 분류 개수는 고정 문자열이 아니라 migration을 PGlite에 적용해 검증한다.

- `official_rule + official_record + editorial_definition = 132`
- 공식 항목 URL 필수, 편집 설명 URL/버전 금지
- **항목별 실정합 감사**: official URL은 위 5종 allowlist에만 속해야 하며, official_record
  term은 페이지별 컬럼 allowlist(예: 타율→HitterBasic1, 완투→PitcherBasic2)와 exact 일치,
  `league` 카테고리·GameManage 계열 URL 조합은 즉시 RED.
- **오매핑 결함 주입 RED**: 대표 결함(league 항목을 GameManage.aspx official로 되돌리기,
  사이클링히트를 타자 기록 페이지에 매핑)을 주입한 사본이 감사에서 반드시 실패해야 한다.

## 2026 변경사항 직접 대조 (답변 본문 유지)

- 수비 시프트: 위반 제재 반영 (editorial)
- 엔트리: 29명 등록·28명 출장 반영 (editorial)
- 외국인 선수: 기존 외국인 3명 외 아시아쿼터 1명 반영 (editorial)
- ABS·피치클락·체크스윙: 답변 본문에 2026 운영 내용 반영, 근거 URL은 미확보로 editorial

검수 대상 132개 term과 최종 분류는
`supabase/migrations/20260730_baseball_qa_seed.sql`의 seed/CASE가 단일 원본이다.
