# 야잘알봇 v2 — 선수/구단 Hybrid RAG 스펙 (rev0.11)

> 상태: **범위 확대 GO(§12) — S1b-KBO/S2 source inventory·ingestion 착수 / S0 merge·Production DB 적용 완료(squash `882f1a1744fb9ead6197a133421b347b3836c96a`, PR #1011 — migration/RPC ACL 적용됨)·실제 계정 2턴 End-User QA HOLD / S1a·S1b·S2 구현 merge/deploy HOLD**
> 작성: 삼식이 2026-07-31 (rev0.11: 삼순 S2a 3차 리뷰 NO-GO 반영 — retry 예산 회복 + 실패 종료 RPC 신설 / rev0.10: 삼순 S2a 재리뷰 NO-GO 3건 반영 — generation 원자성 stage→swap 재설계 / rev0.9: 삼순 S2a NO-GO 5건 반영 / rev0.7: 하린아빠 KBO 기록실+나무위키 전수 RAG 확정 §12 반영 / rev0.6: 삼순 5차 재리뷰 테이블명 exact)
> SSOT: Notion `3aec901b-b372-8140-8cec-f4c700b96487` (본 파일은 미러).
> **rev 정합 기준**: 이 문서의 제목·작성줄·§11 변경이력 최상단은 항상 동일 rev를 가리킨다(현재 **rev0.11**).
> Notion SSOT live 버전은 rev0.11이며, repo mirror는 Notion 확인 후 exact 동기화한다.
> 선행 SSOT: 야잘알봇 MVP 스펙 v1.2 (Notion `3acc901bb3728165b783d0f0960c9f02`)
> 트리거: 하린아빠 2026-07-31 "야구 룰에 이어 구단·선수 질문 대응 + RAG. 이것까지 되어야 킬러피처."

---

## 제0원칙 — 정보 신뢰성이 최우선 (하린아빠 명시, 2026-07-31)

우리에게 가장 중요한 건 정보의 신뢰성이다. **커버리지 < 정확도.** 많이 답하는 것보다 틀리게 답하지 않는 것이 우선이고, **모르면 모른다고 하는 것이 틀리게 아는 척하는 것보다 신뢰를 쌓는다.** 이 원칙이 다른 모든 설계 결정에 우선한다. 저작권 완화(§5)도 이 원칙 아래에서만 — **소스는 넓게, 확정 문턱은 높게.**

신뢰성 게이트(모든 사실 답변에 적용):
1. 정량 수치는 LLM 생성 금지, **조회값(typed claim)만** → 환각 0
2. LLM 답변 속 숫자가 조회값에 실제 존재하는지 **exact 대조**, 없으면 폐기 (안전핀)
3. 조회 실패·불확실·데이터 불완전 → 지어내지 말고 **보류 + 앱 화면 링크**
4. 모든 사실에 **원출처·기준시각(asOf)** 표기
5. 동명이인 모호하면 임의 선택 말고 **되묻기**
6. 서술형은 신뢰등급을 두고 중요 사실은 교차검증, 출처 충돌 시 단정하지 않고 차이 공개
7. 장애·오래된 데이터는 **stale 표시**, 허용기한 초과 시 보류

---

## 0. 조사 결과 — 전제 정정 + 데이터 완전성 실측

### 0.1 초기 전제 정정
- ❌ 초기 구두 제안: "선수·구단·기록을 이미 Supabase에 정확히 갖고 있으니 DB 직조회하면 된다"
- ✅ 실제: 선수 시즌 스탯·팀 기록·순위는 Supabase에 없다. 요청 시점에 KBO 공식 사이트를 HTML 스크래핑하거나 KBO API를 호출한다. → "소스별 신뢰도·가용성·지연을 구분한 retrieval 계층" 필요(2026-07-30 KBO P0 직후라 장애 전파 경로).

### 0.2 데이터 완전성 실측 (삼순 Production 재실측, rev0.2 핵심)
- `player_game_logs`: **16,958행 / 485경기 중 complete ledger 10경기(2.06%)**. 즉 대부분 경기가 부분 적재 → **선수 시즌 누적 집계는 지금 신뢰성 게이트 미통과.**
- **final 일정 universe coverage 100% (exact, rev0.3)**: 시즌 누적/집계 답변의 완전성 게이트는 '표본이 많다'가 아니라 **대상 기간의 *종료(final) 경기 일정 universe*를 100% 커버**해야 통과. 기준 일정 universe = `/api/games` 종료 경기 집합(KBO→Naver 이중화 SSOT). 이 universe의 모든 경기가 complete ledger로 적재됐는지 대조해 **누락 0**일 때만 시즌 누적 개방. 1경기라도 누락/부분이면 '확인된 N경기 기준'으로만 답하거나 보류(부분 표본으로 시즌 단정 금지).
- `players_roster` 테이블: **0행**. 로스터는 정적 JSON(`players-roster.json`, 878명)이 SSOT이고 DB 테이블은 비어 있음 → S1a는 JSON을 dataVersion과 함께 사용, 테이블 의존 금지.
- **결론**: S1a에서 "시즌 누적 스탯"은 데이터 완전성이 확보되기 전까지 답하지 않는다(보류). S1a 착수는 **완전성 검증 게이트 통과가 선결**.

### 0.3 데이터 자산 인벤토리 (실측)
- 선수 로스터·프로필(이름·kboId·팀·포지션·등번호·생년월일) · `players-roster.json`(878명 정적 JSON) · 내부·정적 · ✅ 즉시 사용(지연 0, 장애 0), dataVersion 필수
- 선수 식별/별칭/동명이인/외국인 ID 역매핑 · `resolve-player.ts`(SSOT) · 내부 로직 · ✅ 엔티티 링킹 재사용
- 선수 경기별 로그 · Supabase `player_game_logs` · 내부 DB · ⚠️ **complete 2.06%뿐 → 시즌 누적 HOLD**, 개별 경기 라인은 complete flag 있는 것만
- 선수 시즌 스탯(공식 누적) · `/api/player-stats`→KBO HTML 스크래핑 · 외부 실시간 · ⚠️ 외부 의존·장애 전파(S1b)
- 팀 순위 · `/api/standings`→KBO/Naver 이중화 · 외부(failover 있음) · ⚠️ S1b
- 팀 기록 · `/api/team-records`→KBO HTML 스크래핑 · 외부 실시간 · ⚠️ S1b
- 경기 일정·결과·라이브 · `/api/games`, `fetchKboLiveGames()`(KBO→Naver) · 외부(failover) · ⚠️ S1b
- 야구 룰/용어 사전 · Supabase `baseball_terms`(132개) · 내부 DB · ✅ 기존 MVP 그대로
- Q&A 캐시/질문로그/일일한도/잡 · `genius_*` · 내부 DB · ✅ 확장 사용

### 0.4 오늘 발견한 맥락 버그 — 코드 근거
`pipeline.ts::routeQuestion(question, glossary, players)` 시그니처에 **대화 히스토리가 아예 없다.** 질문 1건 독립 판정 → 야구 신호 0개면 `return "blocked"`. 재현: `보크가 어떤 경우?` 답변 → `또 다른 경우는?` → 신호 0 → blocked. LLM 품질 아닌 **라우터에 대화 상태 부재** 구조 문제.

---

## 1. 목표 / 성공 기준

**목표**: 야잘알봇이 룰/용어를 넘어 선수·구단 질문에 답한다. 단 킬러피처의 조건은 "많이 답하기"가 아니라 **틀린 숫자를 절대 말하지 않기**(제0원칙).

성공 기준(전부 충족해야 각 슬라이스 완료): 제0원칙 신뢰성 게이트 7항 + 맥락 유지(후속질문 미차단) + 비야구 차단 유지 + 외부 장애 내성(KBO 장애 시 오답 대신 degrade).

---

## 2. 질문 3분류 라우팅
- A. 룰/용어("보크가 뭐야?") → 기존 MVP: 사전→캐시→LLM
- B. 정량 사실("김도영 홈런?", "LG 몇 위?") → structured retrieval: 엔티티 해석→조회→typed claim 고정→deterministic renderer
- C. 서술형/맥락("김도영 어떤 선수?") → S2 벡터 RAG(범위만 정의)

기존 `routeQuestion`을 확장. B 중 **내부 자산으로 신뢰성 게이트 통과 가능한 것**만 승격, 나머지는 history_hold 유지.

---

## 3. S1 — Structured Retrieval (벡터 없음)

### 3.1 S1a: 내부 자산만 (외부 의존 0) — **데이터 완전성 선결**
답 가능 범위(완전성 확보된 것만):
- 선수 프로필: 소속팀·포지션·등번호·생년월일 → 로스터 JSON(dataVersion 표기)
- 팀 로스터: "LG 투수 누구?" → 로스터 JSON 필터
- **시즌 누적(경기수·타율·홈런 등)**: `player_game_logs` complete ledger 기준. **현재 complete 2.06%라 전면 보류.** 완전성 게이트(경기 커버리지·라인 완결성 검증) 통과 후에만 개방. 부분 데이터로 "시즌 X개" 단정 금지.
- 최근 경기: complete flag 있는 경기 라인만, "최근 N경기 중 확인된 M경기 기준" 명시.

표기: 우리 로그 기준값은 `크보팬 기록 기준 · asOf YYYY-MM-DD` 명시. 공식 누적과 차이 가능성을 감춘 채 단정 금지.

### 3.2 S1b: 외부 소스 (분리, fail-close) — allowlist/provenance·권리·season 검증 (rev0.3)
- 공식 시즌 누적 → `/api/player-stats`(KBO 스크래핑) / 팀 순위 → `/api/standings`(KBO→Naver) / 팀 기록 → `/api/team-records`
- 각 응답에 **provider(KBO공식/네이버)·asOf(기준시각)·stale(허용기한 초과 여부)·season** 메타 필수.
- **provider allowlist (exact)**: 외부 소스는 사전 허용된 provider 화이트리스트(KBO 공식·Naver 이중화 등)만 채택. allowlist 밖 출처는 typed claim 생성 금지(fail-close).
- **provenance 추적 (exact)**: 모든 typed claim은 어떤 provider·엔드포인트·요청시각에서 나왔는지 provenance를 기록. 답변 렌더 시 출처 표기로 노출, 감사 로그로 역추적 가능.
- **권리(rights) 검증 (exact)**: 팩트(기록·순위)는 저작권 비보호라 채택하되, 원문 장문 재현·유료/접근제한 우회 소스는 rights 게이트에서 배제(§5 라이선스 계약과 결속).
- **season 검증 (exact)**: 응답 season이 질문 대상 시즌과 일치하는지 확인. 불일치(예: 작년 스탯을 올해로 오인)·season 누락 시 채택 금지·보류. 시즌 경계(개막 전/스토브리그) 처리 포함.
- 타임아웃 bounded(1.5~2s). 실패/stale 초과 → 보류 + 앱 화면 링크. **추정값 절대 금지.**
- 캐시 TTL 짧게(순위·라이브성). S1a보다 짧게.

### 3.3 값 고정 계약 (환각 방지 안전핀) — typed claim → deterministic renderer
1. 엔티티 해석: `resolvePlayer`로 kboId 확정. 동명이인 팀으로 분리, 모호하면 **되묻기(AMBIGUOUS 반환)**.
2. 조회: 확정 kboId/teamId로 조회 → **typed claim (7필드 계약)**: ① `value`(수치/사실 원자값) ② `unit`(단위: 개·할·위·경기 등) ③ `entityId`(kboId 또는 teamId) ④ `provider`(출처, allowlist 내) ⑤ `asOf`(기준시각) ⑥ `dataVersion`(로스터 JSON dataVersion 또는 외부 스냅샷 버전) ⑦ `season`(시즌). 7필드 중 하나라도 결측이면 claim 무효 → 보류(불완전 데이터로 단정 금지).
3. 렌더: 수치·핵심 사실은 **deterministic renderer**(템플릿)로 문장 생성. LLM은 (필요 시) 문장 다듬기만, **숫자·사실 토큰은 typed claim에서 그대로 치환**. LLM이 숫자를 새로 만들 자리를 없앤다.
4. 검증: 렌더 결과의 숫자가 typed claim에 존재하는지 exact 대조. 불일치면 폐기 후 보류.

> LLM 자유 문장화 대신 deterministic renderer가 1차 방어, exact 대조가 2차 방어(삼순 blocker 반영).

---

## 4. S0 — 멀티턴 맥락 슬라이스 (선행 핫픽스, 조건부 GO) — exact 계약 (rev0.6: 삼순 5차 재리뷰 테이블명 exact)

### 4.1 설계 + 계약 (삼순 3차 재리뷰 5 blocker 반영)

**[B1] 직전 user turn만 후보 · 중간 turn은 barrier (과거 폴백 금지)**
- 후속 맥락 소스 후보는 **현재 질문 바로 직전의 user turn 1개뿐**이다. 과거로 거슬러 올라가 "가장 최근 completed 야구 turn"을 찾지 않는다(rev0.3의 "가장 최근 1개" 폐기 — AC6 충돌 원인).
- 직전 user turn이 아래 source 자격을 **만족하면 그 turn이 소스**, 못 만족하면 **맥락 없음(barrier)** 으로 종료한다. 중간에 낀 blocked·in-flight·new-topic·비야구 turn은 **barrier**로서 그 이전 어떤 야구 turn에도 결붙을 차단한다.
  - 예: `보크?`(completed 야구) → `주식?`(blocked) → `또 있어?` ⇒ 직전 user turn = `주식?`(부적격) ⇒ barrier ⇒ 맥락 없음(보크로 안 붙음). AC6/신규 AC11 보장.
  - 예: `보크?`(completed 야구) → `오늘 날씨?`(new topic/비야구) → `또?` ⇒ 직전 = new topic ⇒ barrier ⇒ 맥락 없음.

**[B2] answered_at 실체 정의 — 실측 스키마 결속 (exact SQL)**
- 직전 user turn 선정(B1): question 테이블 `q`(dm_messages, `q.id` bigint)에서
  `q.conversation_id = current.conversation_id AND q.sender_id = current.user_id AND (q.created_at, q.id) < (current.created_at, current.id) ORDER BY q.created_at DESC, q.id DESC LIMIT 1`.
- job join: `genius_question_jobs j ON j.message_id = q.id` (⚠️ `question_message_id` 컬럼은 **실재하지 않음** — 실제 FK는 `j.message_id = q.id`, 둘 다 bigint).
- answer DM join: `dm_messages a` where
  `a.dedup_key = 'baseball-genius:' || q.id AND a.sender_id = BASEBALL_GENIUS_USER_ID ('45ae7419-6a9a-4c6b-9101-8d65df7e242e') AND a.conversation_id = current.conversation_id`.
- `answered_at = a.created_at`. **answer DM row가 실제 존재할 때만** source 자격(job이 completed여도 answer DM 없으면 제외, AC13). 조건: `a.created_at < current.created_at`(역순/in-flight 방어, AC10).
**[B3] 자격 필드 = genius_question_jobs.source (match_path 아님, fail-closed)**
- 자격 판정 필드는 `genius_question_jobs.source`다. ⚠️ `genius_question_logs.match_path`는 **message_id FK가 없어 turn과 exact join 불가** → 사용 금지.
- **`j.source IN ('dictionary','cache','llm')`** 일 때만 source 자격(정상 야구 답변 경로). *분포는 시간에 따라 전진하므로 절대 건수 대신 값 집합만 계약*(참고 스냅샷 asOf 2026-07-31: dictionary·llm·cache 순 다수).
- 제외 source 값 집합: `blocked`·`error`·`unsure`·`limited`·`history_hold`(건수는 계속 전진하므로 값 집합만 계약). allowlist 밖 신규 source 값도 기본 제외(fail-closed).
- **status/source 축 분리**: `genius_question_jobs.status`는 전부 `completed`(job 완결성 축)이고 자격은 `source` 축이다. `pending`/`failed`는 source 값이 아니므로 혼용 금지(rev0.4의 pending/failed 혼용 제거).
**[B4] closed-set 후속 문법 = 정규화 full-string 전열거 (open 금지)**
- 후속 판정은 정규화(앞뒤 공백 제거·중복 공백 축약·문말 구두점 `?!.…~` 제거·NFC) 후 **아래 폐쇄집합과 full-string 완전일치**로만 통과. 부분일치·substring·의미분석 금지.
- 폐쇄집합(전열거): `또`, `또?`, `또요`, `또 있어`, `또 있어?`, `또 다른 경우는`, `또 다른 경우는?`, `다른 경우는`, `다른 경우는?`, `더 있어`, `더 있어?`, `더`, `그럼`, `그럼?`, `그건`, `그건?`, `그것도`, `그것도?`, `왜`, `왜?`, `예를 들면`, `예를 들면?`, `예시`, `자세히`, `자세히 설명해줘`, `위 내용과 똑같은 질문입니다`.
- **AC 통과 목록과 집합이 일치**: AC2(`또 다른 경우는?`)·AC3(`위 내용과 똑같은 질문입니다`)가 집합에 포함됨을 스펙-테스트로 결속. 집합 변경 시 AC도 함께 갱신(단일 SSOT 상수).
- full-string 매칭 AND 새 야구 엔티티/주제 신호 부재일 때만 직전 토픽 연장.

**[B5] TTL = answer DM 기준 exact 10분 · global cache read+write 모두 bypass**
- TTL 기준시각 = 소스 turn의 **answer DM created_at**. 현재 질문 created_at − answer DM created_at **> 600초면 맥락 없음**(경계: 정확히 600초는 유효, 600.001초부터 만료 — exact 경계 명시, 신규 AC14).
- 맥락 의존(후속) 질문은 global 정규화 캐시(`genius_qa_cache`)를 **read도 write도 하지 않는다**(bypass). preseed된 동일 정규화 키가 캐시에 있어도 후속 질문은 캐시 히트로 응답하지 않는다(맥락 없는 답 오염 차단, 신규 AC15). 캐시하려면 conversation+토픽 스코프로 격리.

**공통**
- **범위 = same-conversation**: 같은 야잘알봇 DM방(동일 conversation)만. 타 대화·타 유저 누수 금지.
- **프롬프트 주입**: 선정된 소스 turn 1개의 Q/A만 컨텍스트에 포함.

### 4.2 방어 유지
- 인젝션 패턴·출력 검증·서비스 리다이렉트 그대로. 맥락 통과 질문도 LLM 출력 검증(비야구 센티널·야구 신호) 동일 적용.

### 4.3 Acceptance Criteria (rev0.4: B1~B5 결속 AC 추가)
1. `보크가 어떤 경우?` → 답변 ✅
2. `또 다른 경우는?` → 보크 맥락으로 답변 ✅ ← *오늘 실패 케이스* (closed-set 포함)
3. `위 내용과 똑같은 질문입니다` → 차단 아님 ✅ (closed-set 포함)
4. 새 대화 첫 질문이 `또 다른 경우는?` → 맥락 없음 → 정중한 되묻기(차단 문구 아님)
5. `보크 알려줘` 후 `그럼 주식은?` → 차단 유지 ✅ (`그럼 주식은?`은 closed-set 아님 + 비야구)
6. 차단된 질문 뒤 후속형 → 통과 안 됨 ✅
7. TTL 10분 경과 후 후속형 → 맥락 없음 처리 ✅
8. 다른 conversation/유저의 토픽이 붙지 않음 ✅
9. **[동시]** 같은 created_at 두 메시지 → message_id tie-break로 순서 확정, 자기 turn을 source로 삼지 않음 ✅
10. **[역순]** answer DM created_at ≥ 현재 question created_at → 그 turn 소스 제외, **과거 폴백 없이 맥락 없음**(B1) ✅
11. **[B1 barrier]** `보크?`(completed 야구) → `주식?`(blocked) → `또 있어?` → 직전=blocked barrier → 맥락 없음(보크로 안 붙음) ✅
12. **[B1 barrier]** `보크?`(completed 야구) → `오늘 날씨?`(new topic) → `또?` → 직전=new topic barrier → 맥락 없음 ✅
13. **[B2 answer DM 부재]** 직전 job은 completed인데 answer DM(dedup_key) 미존재 → 소스 아님 → 맥락 없음 ✅
14. **[B5 TTL 경계]** `current.created_at − a.created_at`(a=answer DM) 기준 **600.000초 = 유효 / 600.001초 = 만료** ✅
15. **[B5 cache bypass]** global cache에 동일 정규화 키 preseed됨 + 후속 질문 → 캐시 read bypass, 맥락으로만 판정(캐시 오답 미채택) ✅

## 5. 소스 / 라이선스 (rev0.2 — 본문 교체, 저작권 완화·신뢰성 우선)

**원칙**: 저작권을 과도하게 보수적으로 적용하지 않되, `소스 무관 자유 사용/리스크 0`처럼 단정하지 않는다(삼순 지적). 신뢰등급·교차검증·기준일로 거른다. **소스는 넓게, 확정 문턱은 높게.**

- 팩트 데이터(기록·순위·프로필·연혁)는 저작권 보호 대상이 아니므로 **출처 범위를 넓힌다.** 단 신뢰등급·교차검증·asOf로 확정.
- 서술형은 **원문 장문 재현 금지**, 사실만 추출해 재서술 + 출처 표기.
- 최소 법무 가드: **원문 장문 복제·유료/접근제한 우회·과도한 대량수집만** 금지.
- 나무위키: **발굴·보조 출처로 활용 가능**(CC BY-NC라 문서 원문 그대로 서빙만 회피, 사실 참조·재서술 OK).
- LLM 내부 기억값: ❌ 금지(환각 원천, 조회값만).

> 우리 RAG는 'LLM 학습'이 아니라 '검색 후 유저 서빙'이라 학습 fair use 논리를 그대로 쓰진 않되, 위 재서술+출처 원칙으로 회색지대 밖.

---

## 6. 엔티티 별칭 / 동명이인 — AMBIGUOUS/dataVersion
- kboId 유일 키(이름 단독키 금지 — 동명이인 **32그룹**, 로스터 878명 실측 2026-07-31; rev0.2의 27은 stale). 최다 김도현·김동현·김태훈·김현수·박건우·이서준·이재원·이주형·최원준 등 3인 동명 포함.
- `resolvePlayer` SSOT: exact→exact+team→partial+team→partial, 외국인 ID 역매핑.
- 로스터 JSON은 **dataVersion** 부착(어느 버전 로스터로 답했는지 추적).
- 해석 결과가 유일하지 않으면 **AMBIGUOUS 반환 → 되묻기**(임의 선택 금지).
- 팀 통칭·선수 애칭 별칭 사전은 미스 로그 보고 추가(신설 여부 §9).

---

## 7. 가드 (운영 안전)
- 출처·기준시각 표기 필수. 조회 실패/미확인/데이터 불완전 → 보류 + 앱 화면 링크.
- 캐시: S1a(정적·완전 데이터) 길게, S1b 짧게, **맥락 의존은 global cache 제외**(§4.1).
- 일일 한도(KST 20회) 유지. 인젝션 fail-closed 유지.

---

## 8. 평가셋 (eval)
- 정량-내부: 값 정확·출처·완전성 확인분만 · "김도영 홈런?"
- 정량-외부: 실패/stale 시 보류 · KBO 차단 주입 후 "LG 몇 위?"
- 서술형: 보류 or S2 · "김도영 어떤 선수?"
- 멀티턴: §4.3 8케이스
- 비야구/인젝션: 차단·fail-closed
- 동명이인: AMBIGUOUS 되묻기
- **데이터 완전성**: complete 2%인 시즌 누적 질문 → 보류(오답 아님) 검증
- **final 일정 universe coverage**: 종료 경기 일정 universe 대비 complete ledger 누락 0 검증 → 누락 존재 시 시즌 누적 보류(오답 아님) 확인

---

## 9. 열린 결정사항
1. ✅ S1a 먼저(확정). 단 **데이터 완전성 게이트 통과가 S1a 선결**로 추가됨(삼순 실측).
2. ✅ 크보팬 기준 명시 + 공식은 링크(확정).
3. 별칭 테이블 신설 vs resolvePlayer만 — 추천: 기존으로 시작.
4. ✅ 멀티턴 S0 선행 핫픽스 분리(확정).
5. S2 착수 시점 — 라이선스·완전성 정리 후.
6. **신규: player_game_logs 완전성 백필/검증을 별도 트랙으로 선행할지** — S1a 개방 전 필수.

---

## 10. 슬라이스 / 순서 + 삼순 판정 반영
- **S0** 멀티턴 맥락 + 후속질문 차단 해소 · **머지·Production DB 적용 완료** · 실제 계정 2턴 End-User QA HOLD
- **S1a** 내부 자산 정량 답변 · **HOLD** — 데이터 완전성 게이트(§0.2) 선결. 프로필·로스터 필터는 완전하므로 먼저 열 수 있으나 시즌 누적은 보류
- **S1b** 외부 소스 fail-close + provider/asOf/stale/season · **HOLD**
- **S2** 서술형 벡터 RAG · **HOLD**

리스크: ①맥락 개방 우회 →§4 계약 ②외부 장애 전파 →S1b fail-close ③LLM 숫자 환각 →§3.3 deterministic renderer+대조 ④캐시 오염 →맥락 global cache 제외 ⑤불완전 데이터 오답 →완전성 게이트.

---

## 11. 변경 이력

### rev0.11 (삼순 S2a 3차 리뷰 NO-GO 반영 — ingestion 수명주기 종료 경로, 2026-07-31)

rev0.10까지는 claim과 **성공** 종료만 있고 **실패** 종료 경로가 없었다. 그 결과 worker가 죽으면 source를
`ingesting`에서 내릴 수단이 없어 수명주기가 닫히지 않았다.

- **[P0 — retry 예산이 lifetime 누적이라 증분 재수집이 정지]** `ingestion_attempts`가 성공해도 줄지 않아 3세대 만에
  예산이 말라, 서빙 중인 source조차 stale 재claim이 영구히 0건이 됐다. → `complete_baseball_genius_rag_source`가
  성공 시 `ingestion_attempts = 0`으로 예산을 회복시킨다(예산은 "연속 실패" 카운터다). PG17 회귀 R2-B5/R2-B5b.
- **[P0 — 실패 종료 RPC 부재로 `ingesting` 영구 고착]** 함수가 claim/complete/upsert_chunk/record_demand + validator뿐이라
  worker 실패를 DB에 알릴 경로가 없었다. lease 만료로 재claim되면서 attempts만 올라 연속 3회 실패 시점에
  **`ingesting` + `last_error` NULL + claim_token 잔존 + claimable 0**으로 영구 고착했다(PG17 actual 재현 완료).
  운영자는 진행 중인 claim과 죽은 claim도 구분할 수 없었다. → service_role 전용 SECURITY DEFINER RPC
  **`fail_baseball_genius_rag_source(source_key, claim_token, claim_generation, error)`** 신설. exact token+generation이
  일치하는 **그 claim만** 실패 처리해 `last_error` 기록 · lease/token 해제 · `failed` 강등으로 재claim 가능한 상태로
  정리한다. token이나 generation이 어긋나면 **no-op**이라 다른 worker가 재claim한 남의 claim을 죽일 수 없다.
  lease 만료를 종료 조건으로 걸지 않는다 — 걸었으면 고착 상태(만료 + 예산 소진)를 영원히 정리할 수 없다.
  무한 재시도 방지는 불변이다: 종료 RPC는 attempts를 리셋하지 않으므로 예산 회복은 성공 complete만이 한다.
  §12 "마지막 성공 snapshot 보존"도 유지한다: 실패한 generation의 미완성 chunk만 지우고 active generation은 건들지 않는다.
- **[P0 — 실패 경로 경계 회귀 부재]** 성공 경로만 결속되어 있어 위 고착이 재발돼도 게이트가 잡지 못했다.
  → `qa:baseball-source-inventory:db`에 **R2-B6**(연속 3회 실패 고착 재현 → 종료 RPC로 복구, token 불일치·generation
  불일치 no-op, 종료 후에도 소진된 예산은 재claim 불가)와 **R2-B6b**(예산 잔존 실패는 lease 만료 대기 없이 즉시
  재claim, 실패 종료가 마지막 성공 snapshot·서빙 연속성을 파괴하지 않음) 상설 추가. fail RPC ACL(service_role EXECUTE /
  anon·authenticated 차단)도 기존 ACL 매트릭스에 편입. RED(migration 미적용 상태 exit 3)→GREEN 실측.
- **[문서 rev 정합]** 제목 `rev0.9` ↔ 본문 `rev0.10` 불일치를 해소하고(제목·작성줄·변경이력 최상단 = 동일 rev),
  Notion SSOT를 rev0.11로 먼저 승격하고 repo mirror는 그 확인값에 exact 동기화한다.

### rev0.10 (삼순 S2a 재리뷰 NO-GO 3건 반영 — generation 원자성 재설계, 2026-07-31)

rev0.9 B3의 "reclaim 시점 이전 generation purge"는 UNIQUE 충돌은 해소했지만 **§12 "마지막 성공 snapshot 보존" 계약을 깨는 역회귀**를 낳았다. purge를 제거하고 **stage→complete 시점 atomic swap** 구조로 교체한다.

- **[R2-B1 P0 — stale 재수집 claim이 마지막 성공 snapshot을 즉시 삭제]** `claim_baseball_genius_rag_batch`의 `purged` CTE가 후보 이전상태 구분 없이 이전 generation chunk를 전부 지워, `gen1 ready → source stale → gen2 claim`에서 gen1 성공 chunk가 0건이 되고 서빙 공백이 생겼다(§12 위반). → **`genius_rag_sources.active_claim_generation`**(= 마지막으로 complete된 generation) 신설. claim은 새 generation을 **stage**만 하고 active는 건드리지 않으며, purge 대상을 **complete에 도달하지 못한 미완성 generation만**으로 좁혔다(`claim_generation <> active_claim_generation`). chunk UNIQUE 키에 `claim_generation`을 포함해 두 generation이 별도 행으로 공존하고, `complete_baseball_genius_rag_source`가 active를 원자 전환한 뒤에야 비활성 generation을 정리한다. 서빙은 신설 뷰 **`genius_rag_serving_chunks`**(active generation 결속, service_role SELECT 전용)가 담당해 stage 중인 미완성 generation이 검색에 노출되지 않는다.
- **[R2-B2 P0 — current generation에 이질 provenance chunk가 섞여도 ready]** complete RPC가 matching chunk 1건 EXISTS + embedding NULL 0건만 검사해, 같은 claim에 `r-good/doc-good`과 `r-rogue/doc-rogue`를 함께 넣고 `r-good`으로 complete하면 ready가 됐다(오염된 snapshot 서빙). → complete RPC가 **current claim generation의 모든 chunk가 동일 `revision`/`document_content_hash`/`crawled_at`/`claim_token`을 만족**하는지 검증하고 하나라도 불일치면 complete를 거부한다. ready trigger도 `chunk.claim_generation = NEW.active_claim_generation`으로 generation에 결속했다.
- **[R2-B3 P1 — write RPC가 동일 claim 안전 재시도를 거부]** DB commit 후 응답이 timeout되면 worker는 결과를 모른다. 그런데 `ON CONFLICT ... WHERE old_generation < new_generation`만 허용해 같은 token/generation/key 재호출이 `stale rag chunk generation`으로 실패했다. → UNIQUE 키에 generation이 포함되어 충돌 행은 항상 동일 generation이므로, 가드를 **`claim_token` 일치**로 바꿔 같은 claim의 재시도를 idempotent update로 허용한다(중복 행 0). 다른 token의 동일 generation 덮어쓰기는 거부되고, 낮은 generation 역주행은 chunk owner trigger의 generation 검증이 거부한다.
- **§12 계약 준수 명시**: "갱신: revision/contentHash 기반 증분 수집, 삭제·이동 tombstone, bounded rate/retry, **마지막 성공 snapshot 보존**"를 DB 구조로 강제한다. 재수집이 시작되거나(stage) 실패해도(crash) 직전 성공 snapshot은 계속 서빙되며, 교체는 complete 성공 시점의 단일 원자 전환으로만 일어난다.
- **[R2-B4 P0 — ready source에 identity drift가 불가능]** 위 R2-B1 재설계로 `ready`가 `active_claim_generation > 0`과 matching chunk 존재를 요구하게 되자, drift 트리거가 chunk를 전량 삭제하면서도 active·상태를 그대로 두어 **ready source에 대한 identity drift UPDATE 자체가 `ready rag source requires matching provenance chunk`로 거부**됐다(PG17 actual `DRIFT_ON_READY_FAILED=t / final_status=ready`). 이름·소속이 바뀐 문서를 영원히 무효화할 수 없어 잘못된 identity의 chunk가 계속 서빙된다. → drift 트리거가 chunk 삭제와 함께 `active_claim_generation := 0`으로 내리고, `ready`는 `stale`로 강등시켜 재수집 대상으로 둔다(서빙 가능한 snapshot이 없는 source는 ready일 수 없다는 계약과 정합).
- PG17 회귀 추가(RED→GREEN 실측): R2-B4 ready source drift → 거부되지 않고 chunk 0·active 0·`stale` 강등, R2-B1 `gen1 ready → stale → gen2 claim` 시 gen1 chunk·서빙 보존 / `gen2 stage 중 crash → gen1 계속 서빙` / `gen3 complete → active swap + 이전 generation 정리`, R2-B2 이질 provenance 주입 → complete 거부(균일화 후 GREEN), R2-B3 동일 token/gen/key 재호출 → idempotent 성공(중복 0)·다른 token 거부·낮은 generation 거부, 서빙 뷰 ACL(service_role SELECT / anon·authenticated 차단 / chunks 직접 SELECT 전원 차단).

### rev0.9 (삼순 S2a NO-GO 5건 반영, 2026-07-31)
- **[B1 P0 — NULL embedding이 ready로 오인]** `genius_rag_chunks.embedding`이 nullable이고 ready 판정이 "matching chunk 존재"만 보아, embedding을 생략한 chunk로도 `complete=true / source=ready`가 됐다(검색 불가능한 문서가 ready). → 컬럼을 **`extensions.vector(768) NOT NULL`**로 제약하고, ready trigger와 `complete_baseball_genius_rag_source`가 추가로 *current claim generation의 embedding NULL chunk 0건*을 요구하도록 이중 가드.
- **[B2 P0 — service_role ingestion write 경로 부재]** neutral PG17 ACL 실측에서 `chunks INSERT=false`, identity sequence `USAGE=false`라 worker가 chunk를 저장할 수 없었다. → 테이블 직접 write를 열지 않고 **claim token/generation을 검증하는 SECURITY DEFINER RPC `upsert_baseball_genius_rag_chunk`**를 유일 쓰기 경로로 신설(service_role에만 EXECUTE, anon/authenticated REVOKE). claim RPC의 row 반환을 위해 `genius_rag_sources`는 SELECT만 부여.
- **[B3 P0 — crash 뒤 reclaim UNIQUE 충돌]** gen1이 chunk를 남기고 crash하면 lease 만료 후 gen2가 같은 `(source_key, revision, section_path, chunk_index)`를 쓰면서 UNIQUE 충돌 → 재수집 영구 실패·source가 `ingesting`에 갇혔다. → claim RPC가 reclaim 시점에 **이전 generation chunk를 같은 문장에서 정리**하고, 쓰기 RPC는 **generation-safe upsert**(더 큰 generation만 덮어쓰기, 오래된 worker의 역주행은 거부)로 이중 보호. → **rev0.10에서 supersede**: 이 purge 방식이 마지막 성공 snapshot까지 지워 §12를 위반해 stage→swap 구조로 교체됐다.
- **[B4 P1 — Gemini Embedding 2 asymmetric prefix 공식 포맷 위반]** 임의 한글 접두사(`문서 검색용…`/`질의 검색용…`)는 모델 학습 prefix와 어긋난다. → 공식 포맷 적용(query `task: search result | query: …`, document `title: … | text: …`), `embedDocument`에 **pageTitle 전달** 추가, mock exact assert로 회귀 고정.
- **[B5 P1 — §12.2 확정 + workflow 기록 상충 정정]** stale 범위는 rev0.7의 §12.2 `제안·미확정` 기록뿐이며, 상태줄·§10은 이미 최신이라 변경하지 않는다. §12.2는 robots/약관 확인기록·접근제한 우회금지·최소 원문저장·canonical provenance를 **확정 기술 게이트**로 승격하고, 상업 이용 법무만 대량 ingestion/서빙 전 별도 launch gate의 `decision_pending`으로 분리한다. workflow는 실제 PR diff 0건이므로 "하린아빠 승인 전 대기(미추가)"로 정정하고 현재 CI 결속은 prebuild 체인만임을 명시한다. Notion §12.2 승격은 부모가 Notion-first로 병행한다.

### rev0.8 (삼순 S2a inventory 리뷰 blocker 반영 + §12.2 확정, 2026-07-31)
- **[상태 범위 교정]** 상태줄·§10은 이미 **S0 merge·Production DB 적용 완료, 실제 계정 2턴 End-User QA HOLD**로 최신이며 이번 rev에서 변경하지 않는다. stale 범위는 rev0.7의 §12.2 `제안·미확정` 기록뿐이다.
- **[§12.2 확정]** '제안·미확정' 블록을 **확정 기술 게이트**로 승격(robots 확인기록·접근제한 우회금지·최소 원문저장·canonical provenance). 상업 이용 법무 승인만 대량 ingestion/서빙 전 별도 launch gate로 분리해 `decision_pending` 유지.
- **[universe 보강]** KBO 기록실 universe에 실제 프로덕션 호출 경로인 `Player/HitterDetail/Basic`·`Player/PitcherDetail/Basic`과 `Retire/Hitter`·`Retire/Pitcher` 4경로 추가(39→43, 전부 HTTP 200 실측). inventory 928→932.
- **[CI 결속 — 정정]** 앞서 이 항목은 workflow 신설을 기정사실로 적었으나 **workflow 파일은 추가되지 않았다**(PR diff 0건). AGENTS.md상 CI/CD 워크플로 push는 하린아빠 명시 승인 필요 → **하린아빠 승인 전 대기(미추가)** 상태다. 현재 실제 CI 결속은 **`package.json` prebuild 체인만**이며(`qa:baseball-source-inventory` + `qa:baseball-rag-contract`), Vercel 빌이 이를 강제한다. PG17 결함주입(`qa:baseball-source-inventory:db`)은 postgresql@17 의존 때문에 prebuild에서 제외된 수동/로컬 게이트로 남아 있고, GitHub check 강제는 workflow 승인 이후로 유보한다.
- **[PG17 런타임 결함]** 고정 포트 59343 + 빈 locale 탓에 macOS에서 postmaster가 `became multithreaded during startup`으로 즉사해 **게이트가 아예 돌지 못하던** 문제 수정(빈 포트 선택 + `LC_ALL=C`).

### rev0.7 (하린아빠 KBO 기록실 + 나무위키 전수 RAG 확정, 2026-07-31)
- **§12 신규**: KBO 기록실 + KBO/10구단/선수별(878명) 나무위키를 전수 RAG 자산으로 구축. 전수 inventory(resolved|missing|ambiguous|blocked 100% 분류), KBO 기록실=structured typed claim(벡터 아님), 나무위키=서술형 hybrid RAG(provenance 메타 필수). 숫자 정본=공식 KBO, 나무위키 숫자는 교차검증 전 확정 claim 금지.
- **§12.1 실행순서**: S1b-KBO 기록실 inventory/schema → S2a KBO+10팀 ingestion → S2b 선수 878명 batch. 운영 대시보드+재수집 큐.
- **§12.2 기술 게이트(rev0.8에서 확정 승격)**: robots/약관 확인기록·접근제한 우회금지·최소 원문저장·canonical provenance는 확정 계약이다. 단 상업 이용 법무 승인만 대량 ingestion/서빙 전 별도 launch gate로 분리해 `decision_pending` 유지.
- **정책 supersede**: 7/30 "나무위키 운영 RAG NO-GO"는 §5 rev0.2 정책 교체 + §12 하린아빠 확정으로 명시적 supersede.
- 판정: 범위 확대 GO. S1a 내부 완전성은 내부 시즌 누적 게이트로 유지하되 S1b/S2 착수 선행조건 아님. 구현 merge/deploy는 삼순 리뷰+하린아빠 승인 전 HOLD.

### rev0.6 (삼순 5차 재리뷰 테이블명 exact 반영, 2026-07-31)
- **[B3 테이블명 정정]** `genius_qa_log`는 실재하지 않음(Production 404) → 실제 테이블 `genius_question_logs`(match_path 컬럼 존재, message_id 없음)로 전 참조 정정. 자격은 여전히 `genius_question_jobs.source`(logs.match_path는 turn과 exact join 불가라 미사용) 유지.
- **[source 스냅샷]** source 절대 건수는 시간에 따라 전진하므로 스펙에서 제거하고 **값 집합만 계약**(참고 asOf 2026-07-31 표기). 재리뷰마다 건수가 달라 stale 판정되는 문제 해소.
- 판정 유지: S0 exact 계약 반영 후 조건부 GO, S1a/S1b/S2 HOLD.


### rev0.5 (삼순 4차 재리뷰 스키마 exact 2건 반영, 2026-07-31)
- **[B2 스키마 결속]** `genius_question_jobs.question_message_id`는 실재하지 않음 → 실제 FK `j.message_id = q.id`(bigint)로 교정. 직전 user turn·answer DM join을 실측 SQL로 고정(answer sender=BASEBALL_GENIUS_USER_ID `45ae7419…`, dedup_key `baseball-genius:'||q.id`, answered_at=a.created_at).
- **[B3 자격 필드]** match_path(`genius_question_logs`, message_id FK 없어 join 불가) 폐기 → `genius_question_jobs.source IN ('dictionary','cache','llm')`. 제외 source 값 집합: blocked·error·unsure·limited·history_hold(값 집합만 계약, 절대 건수는 스냅샷). status(completed)/source 축 분리, pending/failed 혼용 제거.
- **[AC14]** TTL 경계 600.000초 유효 / 600.001초 만료로 직접 결속.
- 판정 유지: S0 exact 계약 반영 후 조건부 GO, S1a/S1b/S2 HOLD.


### rev0.4 (삼순 3차 재리뷰 5 blocker 반영, 2026-07-31)
- **[B1] 직전 user turn만 후보·중간 barrier(§4.1)**: rev0.3 "가장 최근 completed 야구 turn 폴백"이 중간 blocked/in-flight/new-topic을 건너뛰어 AC6과 충돌 → 직전 user turn 1개만 소스 후보, 부적격이면 과거 폴백 없이 맥락 없음. AC10 역순 폴백도 barrier 안 넘김.
- **[B2] answered_at 실체 정의(§4.1)**: question DM→`genius_question_jobs`→실제 bot answer DM(`dedup_key=baseball-genius:<question_message_id>`) join, answered_at=answer DM created_at, 실제 전달 완료 turn만 source(AC13).
- **[B3] source match_path allowlist(§4.1)**: dictionary|cache|llm만 source, history_hold/limited/pending/failed/blocked/unsure/redirect 제외(fail-closed).
- **[B4] closed-set 정규화 full-string 전열거(§4.1)**: substring/의미분석 금지, 폐쇄집합 전열거 + AC2/AC3 목록 결속(단일 SSOT 상수).
- **[B5] TTL answer DM 기준 exact 10분(600초)·global cache read+write 모두 bypass(§4.1)**: preseed 캐시도 후속 질문 read bypass(AC14·AC15).
- 추가 AC 11~15(barrier 2종·answer DM 부재·TTL 경계·cache bypass).
- 판정 유지: S0 exact 계약 반영 후 조건부 GO, S1a/S1b/S2 HOLD.


### rev0.3 (삼순 2차 재리뷰 exact 반영, 2026-07-31 15:52 `착수착수`)
- **S0 맥락 소스 선정 계약 정밀화(§4.1)**: '직전 turn' → **현재 messageId 이전 + 답변이 현재 질문 전 존재 + completed + 야구 turn 중 가장 최근 1개**의 5조건 exact. 비야구/보류(blocked·unsure·redirect·error) source 명시 제외.
- **후속 통과 = 폐쇄형 문법(closed-set grammar, §4.1)**: open-ended 의미분석 폐기, 정해진 후속 표현 폐쇄집합 매칭 + 새 야구 신호 부재 시만 연장.
- **동시·역순 AC 추가(§4.3 #9·#10)**: message_id tie-break(동시), answered_at 기준 역순 저장 폴백.
- **S1b allowlist/provenance·권리·season 검증(§3.2)**: provider 화이트리스트·provenance 추적·rights 게이트·season 일치 검증 4계약.
- **typed claim 7필드 계약(§3.3)**: value·unit·entityId·provider·asOf·dataVersion·season, 결측 시 claim 무효·보류.
- **final 일정 universe coverage 100%(§0.2·§8)**: 시즌 누적 완전성 게이트를 '표본 수'가 아닌 '종료 경기 일정 universe 100% 커버(누락 0)'로 정의.
- **동명이인 32그룹(§6)**: 로스터 878명 실측(27→32, rev0.2 stale 정정).
- 판정 유지: S0 exact 계약 반영 후 조건부 GO, S1a/S1b/S2 HOLD.

### rev0.2 변경 이력 (삼순 1차 NO-GO 반영 매핑)
- **§5 본문 상충 해소**: 본문을 '위키 제외/법무 금지'에서 완화 정책으로 교체. '소스 무관 자유/리스크 0' 단정 제거 → 신뢰등급·교차검증·기준일.
- **S1a 데이터 완전성**: complete ledger 2.06%·roster 테이블 0행 실측 반영 → 시즌 누적 HOLD, 완전성 게이트 선결(§0.2, §3.1, §10).
- **S0 exact 계약**: same-conversation·직전 completed·TTL 10분·global cache 제외(§4.1).
- **정량 typed claim → deterministic renderer**(§3.3).
- **roster JSON AMBIGUOUS/dataVersion**(§6).
- **S1b provider/asOf/stale/season**(§3.2).
- 판정: S0 조건부 GO(계약 반영 후), S1a/S1b/S2 HOLD.

### 하린아빠 확정 결정 (보존)
- 2026-07-31 '추천대로': ①S1a 먼저 ②크보팬 기준 명시+공식 링크 ③멀티턴 S0 선행 핫픽스. 구현 착수는 삼순 스펙 리뷰 통과 후, merge/deploy는 코드 리뷰 게이트 유지.
- 2026-07-31 저작권 완화 + 정보 신뢰성 최우선(제0원칙).

## 12. 확정 범위 확대 — KBO 기록실 + 나무위키 전수 RAG (rev0.7, 2026-07-31)

하린아빠 확정 결정: KBO 기록실, KBO 나무위키, 10개 구단별 나무위키, 로스터의 각 선수별 나무위키를 모두 야잘알봇 검색 자산으로 구축한다. 범위는 전수 수집이지만 답변 신뢰성 계약은 제0원칙을 그대로 적용한다.

- 전수 inventory: KBO 기록실의 제공 기록 범주 전체 + KBO 개요 1페이지 + 10개 구단 페이지 + players-roster.json 878명 각각의 나무위키 canonical page 후보. 각 엔티티는 resolved | missing | ambiguous | blocked 중 하나로 100% 분류하며 조용한 누락을 금지한다.
- KBO 기록실은 벡터 RAG가 아니라 structured retrieval로 수집·정규화한다. season·entityId·metric·value·unit·provider·asOf·dataVersion을 가진 typed claim만 deterministic renderer에 전달하고, 숫자는 LLM/나무위키에서 생성하지 않는다.
- 나무위키는 서술형 RAG로 사용한다. chunk 메타 필수값: entityType, entityId(kboId/teamId), pageTitle, canonicalUrl, revision, sectionPath, crawledAt, contentHash, sourceGrade, asOf. 이름 단독 연결 금지, 동명이인은 기존 AMBIGUOUS 계약으로 분리한다.
- 임베딩은 지원 모델 `gemini-embedding-2`의 768차원 출력을 사용한다. 문서/질의는 **Google 공식 asymmetric retrieval prefix**를 그대로 쓴다 — 질의 `task: search result | query: {content}`, 문서 `title: {pageTitle} | text: {content}`(title 미상 시 `none`). 임의 한글 접두사는 모델이 학습한 prefix와 어긋나 index/query 정렬을 깨므로 사용하지 않는다. `task_type`은 전송하지 않으며, 768개 유한값이 아닌 응답은 저장 전 거부한다. 실 API 768 finite 검증은 `GEMINI_API_KEY` 보유 환경의 별도 launch gate(`verify-embedding-live`)에서 수행하고, PR 게이트는 mock 포맷 exact assert로 고정한다.
- 검색은 entity filter + hybrid(BM25/vector)로 구성한다. 문서 안의 지시문·프롬프트·스크립트는 모두 비신뢰 데이터로 취급하고 모델 지시로 실행하지 않는다.
- 신뢰도: 공식 KBO 기록실을 정량 claim의 우선 정본으로 사용한다. 나무위키의 숫자는 공식 소스로 교차확인되기 전 정량 확정값으로 쓰지 않는다. 서술형은 출처·revision/asOf를 표시하고, 공식/다른 출처와 충돌하면 단정 대신 차이를 공개한다.
- 서빙: 사실을 재서술하고 원문 장문 재현은 피하며 답변에 canonical source 링크를 제공한다. 로그인·유료·접근제한 우회는 하지 않는다.
- 갱신: revision/contentHash 기반 증분 수집, 삭제·이동 tombstone, bounded rate/retry, 마지막 성공 snapshot 보존. stale 허용기한 초과 또는 source 장애 시 stale 표시 후 보류한다.
- 완료 게이트: inventory 분류 100%, resolved 문서 ingest 성공 100%, missing/ambiguous/blocked 공개 목록, 출처 링크 유효성, 동명이인·시즌·revision·stale·source-injection·숫자 환각 회귀를 모두 통과하기 전에는 전수 완료라고 표현하지 않는다.

### 12.1 실행 순서

1. S1b-KBO 기록실: source inventory → extractor/schema → typed claim/renderer → 장애·시즌·수치 exact eval.
2. S2a: KBO 개요 1 + 구단 10페이지 ingestion, entity-filtered hybrid retrieval, citation/revision eval.
3. S2b: 선수 URL inventory는 전수 확정·유지한다. 선수 문서 embedding·갱신은 실제 질문 조회 빈도 내림차순의 작은 batch로 ingestion·평가·롤백 가능하게 확대하되 최종 목표 범위는 전원이다.
4. 운영: source coverage/revision/stale/실패율 대시보드와 재수집 큐를 두고, 실제 질문 eval에서 정량 exact와 서술형 citation을 분리 판정한다.

판정: 범위 확대 GO. S1a 내부 player_game_logs 완전성은 내부 시즌 누적 서빙 게이트로 유지하되, KBO 기록실 S1b와 나무위키 S2의 source inventory/ingestion 착수를 막는 선행조건으로 사용하지 않는다. 구현 PR은 삼순 코드리뷰와 하린아빠 merge 승인 전 merge/deploy HOLD.

정책 판정: 7/30 기존 "나무위키 운영 RAG NO-GO"는 최신 Notion §5 rev0.2의 정책 교체 + §12 하린아빠 확정으로 명시적으로 supersede된 것으로 본다.

### 12.2 수집 기술 게이트 (✅ 확정 — rev0.8, 2026-07-31 하린아빠 ③ 역할분리 통합안)

아래 (a)~(d)는 **제안이 아니라 확정된 기술 게이트**다. inventory·ingestion 모든 수집 경로가 이를 충족해야 하며, 위반 source는 `blocked`로 분류하고 수집하지 않는다.

- **(a) robots/약관 확인기록 필수 (확정)**: robots.txt·약관을 확인하고 **확인기록을 남긴** 경로만 bounded 수집한다. 확인기록 없는 source는 ingest 대상이 아니다.
  - 2026-07-31 실측: KBO `Disallow: /Common/ /Help/ /Member/ /ws/` → `/Record/` 허용. namu `Allow: /w/` → 문서 경로 허용.
- **(b) 접근제한 우회 금지 (확정)**: 로그인·유료·지역차단·봇차단 우회를 하지 않는다. bounded rate/retry를 지키고 과도한 대량수집을 하지 않는다.
- **(c) 최소 원문저장 (확정)**: 원문 전문 보존 금지. retrieval에 필요한 **chunk + provenance**만 저장하고, 서빙은 재서술 + 출처링크로 한다. attribution/license 메타 보존.
- **(d) canonical provenance (확정)**: 모든 chunk는 canonical URL·revision·contentHash·crawledAt·sourceGrade를 보유한다. canonical 미확정 source는 `resolved`가 될 수 없고(DB CHECK + claim 이중 술어로 강제) ingest 대상에서 제외된다. **HTTP 200 단독으로 canonical을 단정하지 않고** redirect 최종 URL 정규화 + page identity(canonical link·title) 일치를 확인한다.

### 12.3 S2b thin-slice waiver — retrieval은 vector-only (2026-08-01, 삼순 R1 P1 반영)

§12는 최종형 retrieval을 "entity filter + hybrid(BM25/vector)"로 정의한다. **S2b 수직 슬라이스의 구현은 hybrid가 아니라 vector-only다** — BM25/lexical 경로는 구현되어 있지 않다. 이를 미구현 결함이 아닌 **명시적 waiver**로 기록한다.

- 근거: entity 필터가 이미 후보를 문서 1건(선수 1명 = source 1건)으로 고정하므로, 남는 상위 선별은 한 문서 안 chunk 수십 개 정렬이다. lexical 병합의 이득은 작고, 도입하려면 tsvector 인덱스 + 새 RPC가 필요해 수직 슬라이스 범위를 벗어난다.
- 구현 표기: `src/lib/baseball-qa/rag/retrieve.ts`의 `RAG_RETRIEVAL_MODE = "vector_only"`가 계약 표기이며, 회귀(`qa:baseball-rag-serving`)가 이 값과 본 문서의 waiver 존재를 함께 고정한다. "hybrid 구현됨"으로 표기하는 것은 금지된다.
- 해소 조건: 선수 전수(878명) 확대 단계에서 entity 필터만으로 후보가 충분히 좁혀지지 않거나 동의어/별칭 검색 품질 이슈가 관측되면 hybrid를 별도 트랙으로 구현하고 이 waiver를 해제한다.

### 12.4 tier2 소스 구성 — 위키피디아 기본 / 나무위키 보조 (2026-08-01 R3, 하린아빠 지시)

tier2(서술형) 소스는 **두 개**이며 역할이 다르다. 둘 다 tier2이므로 §12 수치 계약(숫자 정본은 공식 KBO)은 변하지 않는다.

| | 위키피디아(ko) | 나무위키 |
|---|---|---|
| 역할 | **기본** | 보조(팬덤 디테일) |
| 접근 | 공식 API `/w/api.php`, 정직한 UA plain fetch | Playwright 실크롤(수집 스크립트 전용) |
| revision | `revid` = **정본** | 크롤 시각(`crawled:`) |
| 서버 런타임 | 가능 | **불가**(Playwright 의존) |
| source_key | `wikipedia:player:<kboId>` | `namu:player:<kboId>` |

- **충돌 계약**: 서술이 충돌하면 **위키피디아 우선**(`orderTier2Evidence`가 근거 순서를 고정). 나무위키는 위키피디아에 없는 정보(별명·팬덤 서술)를 보충할 때 근거가 된다. 어느 쪽이 근거였는지는 canonical URL 출처 표기로 항상 구분된다.
- **실측 근거(2026-08-01)**: 위키피디아 선수 문서 평균 약 4천자에 별명 항목이 거의 없다. 나무위키 문보경 문서에는 별명 서술이 다수 있다. 그래서 "기본=검증 절차가 있는 위키피디아, 보조=서술 디테일" 구성이다.
- **DB**: `source_kind`에 `wikipedia_document` 추가(migration `20260801220000_...`). tier 매핑은 `wikipedia_document → tier2` 강제이며 tier1로 저장할 수 없다.

### 12.5 나무위키 수집 경로 — 실브라우저 bounded rate (2026-08-01 R3, §12.2(b) 준수 방식 확정)

rev0.8 시점의 "namu.wiki는 프로그래매틱 접근 전면 차단(정상 결과 = `blocked`)"은 **plain fetch 경로에 한정된 사실**이며, 다음 조건에서는 우회 없이 정상 200이다(실측 8/8 200, blocked 0).

- 실제 Chrome 채널(`channel: "chrome"`) + headed(`headless: false`)
- **요청마다 브라우저 완전 재기동**(launch → 1페이지 → close)
- **요청 간 최소 10초**(`RAG_FETCH_INTERVAL_MS` / `NAMU_BROWSER_MIN_INTERVAL_MS`, fetcher가 스스로 강제)

403의 원인은 봇 판별이 아니라 **같은 브라우저 세션의 연속 요청**이었다(2.5초 연타 시 2번째부터 403, persistent 프로필 403, headless 403). 따라서 이 경로가 하는 일은 **요청 빈도를 낮추는 것**뿐이며 §12.2(b) bounded rate 요구와 같은 방향이다.

- **우회 미사용(계약)**: 위장 UA·challenge solver·쿠키/세션 재사용·persistent 프로필·로그인 우회는 **존재하지 않으며 추가 금지**다. 회귀(`qa:baseball-rag-serving`)가 소스에서 이를 고정한다.
- **차단 시**: `been blocked` 본문 시그니처 포함 즉시 `blocked`로 종료하고 **배치를 중단**한다(재시도 폭주 금지).
- **위치 경계**: 실크롤 fetcher는 `scripts/baseball-qa/rag/fetch-namu-browser.ts`에만 존재한다. Playwright는 Vercel 서버리스에 올릴 수 없으므로 `src/`(서빙 번들)는 이를 import하지 않으며, 회귀가 "`src/` 내 playwright import 0건"을 고정한다.

### 12.6 canonical identity 게이트 — 제목 폐쇄집합 → 문서 분류 대조 (2026-08-01 R3, 실 마크업 실측 반영)

§12.2(d)의 identity 대조 방식이 **실 마크업 기준으로 교체**되었다. (1) redirect 최종 URL, (2) `rel=canonical`, "HTTP 200 단독 canonical 금지"는 그대로다.

- **RED(실측)**: 이전 방식(제목이 `{이름}` / `{이름}(야구선수)` / `{이름}(야구)` 폐쇄집합에 속하는가)을 실크롤 HTML 16건에 그대로 걸면 **16/16이 통과하지만 그중 5건이 남의 문서**였다 — `강백호`·`김현준`·`박재현`·`이원석`(동음이의/동명이인 문서), `네일`(영어 단어 문서). 실제 선수 문서명이 `(2002년 10월)`·`(1999)`처럼 예측 불가능하거나 등록명이 다르기(`네일` → `제임스 네일`) 때문이다.
- **교체된 (3) identity 판정**: 문서가 스스로 선언한 **분류(category)**로 판정한다. 나무위키(HTML 분류 링크)와 위키피디아(API `prop=categories`)가 같은 함수(`verifyPlayerDocumentIdentity`)를 쓴다.
  - (3a) 동음이의/동명이인 분류가 있으면 거부
  - (3b) `…야구 선수` 분류가 없으면 거부
  - (3c) 로스터 생년과 `{생년}년 출생` 분류가 불일치하면 거부 — **동명이인 오귀속의 결정적 차단선**
  - (3d) 문서 제목에 선수 이름이 포함되어야 함(등록명 표기 차이는 허용)
  - identity 근거(이름+생년)가 없으면 `identity_evidence_absent`로 **확정하지 않는다**(fail-close)
- **동음이의 문서 처리**: 실패가 아니라 **후보 목록**으로 쓴다. 문서가 링크한 같은 이름 문서를 후보로 뽑아(`extractDisambiguationCandidates`, 상한 6건) 각각 분류로 확인한다.
- **실측 결과**: 거부 5/5(구판 fail-open 전부 차단), 통과 16/16(과차단 0). 회귀가 실 마크업 fixture로 이 둘을 함께 고정한다.

### 12.7 최소 원문저장 상한 재산정 (2026-08-01 R3, 실문서 길이 분포 기준)

§12.2(c) 보존 상한을 추정값(25% / 2,700자)에서 **실측 기반**으로 재산정한다: **20% / 2,400자**.

- **절대 상한 2,400자 = `RAG_EVIDENCE_LIMIT`(4) × `RAG_EVIDENCE_MAX_CHARS`(600)** — 서빙이 프롬프트에 넣을 수 있는 근거 총량과 정확히 같다. 그보다 많이 저장하면 **서빙에 한 글자도 쓰이지 않는 원문**을 보관하는 것이고, 그것이 §12.2(c)가 금지하는 바다.
- **비율 20%** — 실크롤 문서 정리본 길이는 1,899~31,462자(중앙값 약 20,000자)다. 20%면 최단 문서에서도 chunk가 남고, 최장 문서에서는 절대 상한이 걸려 실보존이 7.6~9.6%로 떨어진다(전문 재구성 불가가 강화된다). 25%였다면 최장 문서에서 7,883자까지 허용되어 상한이 사실상 유일한 방어선이 된다.
- **답을 깨지 않음(실측)**: 문보경 문서(정리본 25,009자)에서 별명 서술 문단이 상한 안에 보존된다. 실제 서빙 관통에서 `문보경 별명이 뭐야?`가 답으로 나온다.
- **짧은 문서의 fail-close는 계약대로다**: 위키피디아 최단 문서(김백산 191자, 네일 134자)는 보존 예산이 최소 chunk 길이에 못 미쳐 `no_retrievable_snippet_within_retention_budget`으로 저장하지 않는다. 이 선수들은 나무위키(보조 소스)가 커버한다.
- **하위문서 합산 상한(R4)**: 문서별 20%/2,400자만 적용하면 하위문서 20건에서 최대 48,000자를 쌓아 entity corpus 상당 부분을 재구성할 수 있다. 따라서 메인+하위문서 **전체 정리본 합계의 10% / 12,000자 중 작은 값**을 다시 적용한다. 12,000자는 1회 서빙 최대 근거량 2,400자의 5배다. 문서별 첫 근거부터 round-robin 선별해 traversal 첫 문서의 예산 독점을 막고, 합산 상한을 넘으면 저장하지 않는다.

### 12.8 나무위키 하위문서 bounded 재귀 수집 (2026-08-01 R4, 하린아빠 지시)

메인 문서만으로는 선수 경력·플레이 스타일 등 서술의 절반 이상을 놓칠 수 있으므로, 메인(depth 1)에서 같은 entity 하위문서를 depth 3까지 BFS로 수집한다.

- **entity 귀속**: 확정된 메인 canonical title을 prefix로 사용한다. decoded 문서명이 `${메인}/…`인 링크만 따라가며 다른 선수·일반 문서는 fetch하지 않는다. 하위문서도 최종 URL + `rel=canonical` + page title을 대조하고 canonical title의 prefix 일치를 다시 확인한다.
- **anchor dedupe**: `#s-2.1`·섹션명 fragment와 query를 제거한 canonical 문서 URL로 정규화·중복 제거한다. 같은 문서의 섹션 링크는 요청 1건이다.
- **bounded rate**: 모든 하위문서 요청도 동일한 fetcher를 거쳐 문서마다 최소 10초 + 요청별 Chrome 완전 재기동을 강제한다. blocked는 즉시 entity/배치 중단이다.
- **상한**: `NAMU_MAX_CRAWL_DEPTH=3`, `NAMU_MAX_DOCUMENTS_PER_ENTITY=30`. 최정 실측 고유 하위문서 20+건에 약 40% 여유를 주되, 30건이면 rate 대기만 최대 약 5분으로 제한된다. depth 4 링크 또는 31번째 unique 문서를 발견하면 일부 corpus를 ready로 만들지 않고 entity 전체를 fail-close한다. 이 상한에 맞춰 claim lease는 15분이다.
- **추적성**: chunk `sectionPath`에 decoded 계층(`문보경/선수 경력/2024년`)을 기록하고 최종 출처 표기에도 노출한다. DB owner 계약상 `canonical_url`은 source root를 유지하며, 실제 하위 경로는 `sectionPath`와 chunk metadata에 남긴다.
- **실측(2026-08-01)**: 문보경 root에서 고유 문서 10건(root 1 + 하위 9)을 canonical 통과 수집했고, 미래 링크 `문보경/선수 경력/2027년` 1건은 HTTP 404라 저장하지 않고 rejection provenance에 남겼다. prefix 밖 fetch 0건.

**분리된 게이트 — 상업 이용 법무 승인 (`decision_pending`, 미확정 유지)**: 나무위키 CC BY-NC 기반 상업 서빙 가능 여부는 **inventory 단계의 게이트가 아니다.** 대량 ingestion 및 유저 서빙 개시 전 **별도 launch gate**에서 판단하며, 하린아빠 확정 전까지 `decision_pending` 상태를 유지한다. 이 상태에서도 inventory 확정·canonical 검증은 진행한다(수집/서빙과 분리).

- sourceGrade·공식 KBO 우선순위는 Notion §12에 이미 반영됨(중복 아님).
