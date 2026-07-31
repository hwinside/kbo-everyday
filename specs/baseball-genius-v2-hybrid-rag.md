# 야잘알봇 v2 — 선수/구단 Hybrid RAG 스펙 (rev0.6)

> 상태: **S0 스펙 GO (2026-07-31)** / 구현 PR #1011 코드 재리뷰·merge·deploy HOLD / S1a·S1b·S2 HOLD
> 작성: 삼식이 2026-07-31 (rev0.6: 하린아빠 15:52 `착수착수` + 삼순 5차 재리뷰 테이블명 exact)
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
- **S0** 멀티턴 맥락 + 후속질문 차단 해소 · **계약(§4.1) 반영 후 조건부 GO** · 선행 배포
- **S1a** 내부 자산 정량 답변 · **HOLD** — 데이터 완전성 게이트(§0.2) 선결. 프로필·로스터 필터는 완전하므로 먼저 열 수 있으나 시즌 누적은 보류
- **S1b** 외부 소스 fail-close + provider/asOf/stale/season · **HOLD**
- **S2** 서술형 벡터 RAG · **HOLD**

리스크: ①맥락 개방 우회 →§4 계약 ②외부 장애 전파 →S1b fail-close ③LLM 숫자 환각 →§3.3 deterministic renderer+대조 ④캐시 오염 →맥락 global cache 제외 ⑤불완전 데이터 오답 →완전성 게이트.

---

## 11. 변경 이력

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
