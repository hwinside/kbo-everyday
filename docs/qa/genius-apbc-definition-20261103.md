# APBC 정의 누락 — 2026-11-03 일일 개선

## 근거와 범위
- 분석창: 2026-11-02T00:24:23.412726+00:00 ~ 2026-11-03T00:24:23.412726+00:00 (직전 24시간, UTC).
- 로그 17행/16 QID/6계정. #1607 전용 QA 동일 계정의 10 exact QID를 별도 분리: 3279604, 3279606, 3279608, 3279610, 3279612, 3279614, 3279616, 3279618, 3279620, 3279622. QA 원본 `qa-1607.out`의 5 시나리오+setup 및 actor 결속 근거. 숫자 구간 전체 제외가 아니다.
- 나머지 7로그/6질문/5계정. Q3279809는 교정 안내와 최종 사전답의 중복 로그. QA 표식 없음은 실사용 신원을 확정하지 않는다.
- Q3279799 `APBC가 뭐야?` → `unsure`, 실제 DM3279800 `이 내용은 지금 정확히 답변드리기 어렵습니다.`. job completed·answer 일치 및 같은 conversation 실제 전달 확인. 직전 대화는 전날 규칙 질문이며 APBC 후속 문맥이 아니다.
- 현재 운영 사전 166행 전수에 APBC/한글명/영문명 없음. origin/main `eb1eae9eb5db20c594bd868d080fe3253730d6e0`에서 시작. 기존 PR/원격 브랜치 확인: 이 사전 항목 개선 중복 없음. #1541·실험 Draft 및 재작업 횟수는 건드리지 않음.
- 원본은 접근 제한된 내부 `state/genius-quality-loop-20261103/sample/`. 로그 SHA256 `138e044e15e57c8b4228a7f6582c07700e003c2bb63d72940cc30c2a9219276e`. PR에는 공개 용어 사전만 fixture로 포함, 사용자/대화 식별자 원본은 미포함.

## 변경
기존 검수 사전 경로에 APBC 1행을 추가한다. 모델·정규식·분류/수치 가드·캐시·추가 호출 변경 없음. 기존 행은 ON CONFLICT DO NOTHING으로 보존한다.
- APBC = Asia Professional Baseball Championship = 아시아 프로야구 챔피언십.
- 젊은 프로 선수 중심의 국가·지역 대표팀 국제 대회라는 정의만 제공.
- 공식 주최측 자료: https://www.japan-baseball.jp/en/team/topteam/2023/asiachampionships/overview.html (2026-11-03 조회). NPB 공식 연결: https://npb.jp/apbc/2023/ .
- `editorial_definition`은 공식 자료를 바탕으로 작성한 설명이지 공식 규칙 인용이 아님. source_url에 검수 원문 유지, rule_version=not_applicable.
- 대회별 일정·나이/경력 자격·참가국·우승팀을 영구 정의에 포함하지 않는다. 이에 대한 질문은 정의로 덮지 않는다.

## 독립 검증 — 삼식 실행/판정 대기
```sh
npx tsx scripts/qa/genius-apbc-definition.ts
```
PGlite 실제 schema+운영 사전 fixture에 migration을 두 번 적용: 166행 전 필드 보존, 1행만 추가, 정규화 키 충돌 없음, 기존 동명 행 덮어쓰기 없음. base 원질문 미매칭과 적용 후 5개 표기 종단 dictionary/정확한 답변/모델0호출 확인. 일정·우승·자격·비교·선수·유래·접두 오염·WBC 8개 반례는 고정 정의로 삼키지 않아야 한다. 이는 오프라인 경로 검증이며 live 모델 의미 분류·실제 UI를 대신하지 않는다.

운영 적용 후 전용 계정 실제 DM에서 원질문/소문자/한글명 및 일정·자격·WBC 비교·유래 반례를 확인한다. 기존 dictionary 사전 TTL 경과 후 신규 질문으로 확인하고 옛 completed job 재전송으로 검증하지 않는다. 기존 `DH 약자`·타팀 순위·timeout은 이 PR 범위 밖이다.

## 적용/롤백
아직 운영 DB 적용하지 않음. PR 머지/배포만으로 데이터 적용 완료라 하지 않는다.
1. 적용 직전 전체 사전 snapshot 및 APBC/별칭 충돌 재확인. 기존 동명 또는 정규화 별칭 충돌 발견 시 적용 HOLD(자동 덮어쓰기 금지).
2. 승인된 배포 단계에서 이 migration만 transaction으로 실행. 기존 166행 전체 동일/추가 1행의 모든 필드가 migration과 일치하는지 확인하고 불일치면 rollback. 새 ID를 기록한다.
3. migration 등록·사전 TTL 후 DM QA를 별도로 확인한다. 서버 `loadGlossary`가 DB 사전을 사용한다.
4. 롤백은 사전 snapshot에 없던 신규 ID이며 term/aliases/answer/category/source_kind/source_url/rule_version/reviewed_at이 삽입 payload와 모두 일치할 때만 해당 1행 삭제. 수정됐거나 기존 행이면 HOLD. 기존 사전·캐시·로그·DM 변경/소급발송 없음.

## 작성자 확인
- 독립 QA 스크립트 미실행(담당 삼식), 의미 PASS 주장 없음.
- Graphify rebuild 시도: 환경에 graphify 모듈이 없어 실행 불가. 제품 의존성 변경 없음.
- QA 스크립트 및 종속 제품 타입검사 PASS(Next RequestInit 전역 타입 포함), ESLint PASS. 독립 QA 실행은 아님.
