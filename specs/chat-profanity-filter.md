# 크관 채팅 비속어 자동 필터 — Spec rev0.5

> Status: DRAFT (삼순 P0 조건부 GO / P1 HOLD — 2개 추가 계약 반영본) · Owner: 삼식이 · Review: 삼순이
> 근거 데이터: 9/1~9/2 KST 크관 채팅 전수 (원장 `state/qa/chat-2d.json`, 스캔 `state/qa/profanity-scan.py`)
> Notion SSOT: https://www.notion.so/3d0c901bb37281f89025c2eb4cc52978
> 현행 코드 실측 base: current main `39e2a652b` (`src/lib/moderation/content-filter.ts`)

## 0. 배경 / 문제

- 유저 건의(운영자 쪽지 `창기사랑창기`): "비속어 걸러주는 기능 없나요? 팬들 비난이 많다."
- 실측(삼순 전수 교차검증): 노출 원문 7,998건(삭제 238 제외, 전체 8,236) 중
  - 넓은 비속어 노출 후보 **117건(1.46%)**
  - 명확한 인신공격·위협·퇴출성 **26건 안팎(0.33%)**
  - 패드립·성적·지역·인종 비하는 이번 표본 미발견.

## 0.1 현행 필터 실측 (§9(a) 해소 — current main `39e2a652b`)

- 공용 모듈 `src/lib/moderation/content-filter.ts` — `checkObjectionableContent({title,content})`.
- `BLOCKED_WORDS` 12개(**기존 검증어**): `시발 씨발 좆 병신 미친놈 꺼져 ㅅㅂ ㅂㅅ ㅈㄹ ㅆㅂ 지랄 새끼`.
- 정규화: NFKC + 공백/제로폭 제거 + 문자·숫자만. 우회 탐지 `buildFlexiblePattern`(글자 사이 0~3자 삽입 매칭) **이미 존재**.
- **사용처(공용)**: `useChat.ts`(채팅), `usePosts.ts`(글·댓글), `api/polls/route.ts`·`api/polls/[postId]/route.ts`(투표), `api/content-filter/route.ts`(서버 라우트 이미 존재).
- 채팅 전송 현행 경로: `useChat` 클라 사전검사 → **클라가 `chat_messages`에 직접 insert**(RLS 허용).
- ⚠️ **현행 오탐 리스크 실측**: `새끼`가 substring+0~3자 삽입 매칭이라 `새끼손가락`·`손 새끼줄` 등 오탐. rev0.5에서 어절/경계 판정으로 교정.

> **회귀 계약(타 UGC 비회귀)**: 채팅 필터 강화가 **글·댓글·투표 동작을 바꾸지 않아야** 한다. 공용 `checkObjectionableContent` 시그니처/결과는 타 UGC 대해 byte 동일 유지, 채팅 전용 강화는 별도 모듈(`lib/chat/profanity/`)로 분리하고 "타 UGC 비회귀" 골든 회귀를 게이트에 포함.

## 0.2 채팅 경로 필터 교체 계약 (blocker rev0.5-① — 오탐 즉시 해소)

- **`useChat` 채팅 경로에서 공용 `checkObjectionableContent`를 제거/대체**한다. 그대로 두면 새 모듈이 붙기 전까지 `새끼손가락` 등 현행 오탐이 계속 차단됨.
- 채팅은 신규 `lib/chat/profanity/`(span allowlist·어절 경계) 로직만 사용.
- **게이트**: 클라→API 실제 전송 E2E에서 `새끼손가락` 포함 문장 **PASS**(차단 안 됨) 실측 + 글·댓글·투표는 **기존 동작 유지**(공용 모듈 미개변).

## 1. 핵심 제약 (데이터가 강제하는 것)

1. 실제 강성 공격은 희소(0.33%) → 과잉 차단의 손실 > 이득.
2. 최대 리스크 = **정상 응원 오탐**: `못보지`/`바보지`(보지), `강한남자`(한남), `미친 레전드`(미친), `아니미친`의 `니미`, `새끼손가락`(새끼).
3. 단순 substring 금지. 정규화 + 어절/형태소 경계 필수.

## 1.5 오탐 최소화 = 최우선 설계 원칙 (하린아빠 명시 2026-09-03)

> "정상 응원을 막는 비용 > 욕 하나 놓치는 비용." **Precision을 Recall보다 우선.**

1. **기본값 PASS.** 확신이 없으면 통과. 애매하면 차단 금지.
2. **allowlist는 span 단위로만 무효화 (전체 PASS 금지).** 반례 매칭은 **그 반례와 겹치는 span의 동일 rule HARD 후보만** 무효화하고, 문장 나머지의 다른 span·다른 rule HARD 후보는 계속 검사한다. ⚠️ `새끼손가락 ㅆ벌`·`강한남자 김경문 죽어`는 통과시키면 안 됨. 반례 예(`강한남자`·`못보지`·`바보지`·`아니미친`·`정신병(단독)`·`새끼손가락`·`귀여워 죽어`·`죽어라 뛰자`)는 **해당 span만** 면책.
3. **HARD 사전은 좁고 고신뢰만.** 문맥 없이 100% 욕만. 정상 용법 조금이라도 있으면 HARD 금지 → shadow.
4. **문맥어(`미친/ㅈㄴ/개-`)는 V1 자동 하드차단 절대 안 함.** shadow 로깅으로 오탐률 실측 후에만 승격.
5. **정량 게이트**: P0 합성 골든셋 정상 반례군 **오탐 0건**(미충족 시 머지 불가). shadow 승격은 관측 오탐률 **< 1%**일 때만(§8 정의).
6. **즉시 롤백**: 전역 enforce→shadow **kill switch**(코드 핫패치 아님, §8).
7. 대상 지목(로스터/닉네임)은 **가중치로만** — 단독 차단 트리거 금지.

## 2. 정책 (3단계 강도)

현행 하드차단보다 **후퇴 금지**. 기존 12어는 enforce 유지, 신규 HARD는 shadow 검증 후 승격.

| 등급 | 대상 | V1 동작 |
|---|---|---|
| HARD(기존 12어) | `시발 씨발 좆 병신 미친놈 꺼져 ㅅㅂ ㅂㅅ ㅈㄹ ㅆㅂ 지랄 새끼`(단, `새끼`는 어절 경계 교정) | **enforce 유지**(완전 거부·raw 미보존) |
| HARD(신규 rule) | `ㅆ벌/시팔/시부럴/ㅅㄲ/쌔끼/야랄`, 의도적 `ㅗ`, 위협(`죽어/닥쳐/멸종돼라`) | **먼저 shadow+`message_id` 로그 → 규칙별 게이트 통과 후 enforce**(blocker rev0.5-②) |
| SOFT | 문맥 의존어(`미친/ㅈㄴ/개-` 계열) | shadow(무동작 로깅) → 소프트 가림 순차 승격 |
| PASS+가중 | 경기력 야유(`못친다/2군보내라/방출`) | 통과, 신고 누적 시 가중치 |

## 2.1 HARD 판정 문법 & 반례

- **`죽어` 계열**: 단독/위협 대상 co-occurrence만 HARD. 반례 통과 필수: `귀여워 죽어`, `죽어라 뛰자`, `좋아 죽겠다`, `죽여주네`. → 어절 경계 + 부정/명령/위협 문맥 신호 없으면 PASS.
- **의도적 `ㅗ`**: 단독/반복(`ㅗㅗ`)·문장 끝 욕설 문맥만 HARD. 반례 통과: `해주세ㅗ오`(오타). → 어절 내 정상 음절 결합이면 PASS.
- **`ㅅㄲ/쌔끼/새기`, 기존 `새끼`**: 어절 경계 판정, `새끼손가락`·`손새끼줄` span 면책.
- 모든 HARD 규칙은 반례를 **골든셋 정상 반례군**에 넣어 오탐 0을 게이트로 증명.
- **우회 취약 무효화 mutation 회귀**: `새끼손가락 ㅆ벌`(→ `ㅆ벌` span HARD 검출) · `강한남자 김경문 죽어`(→ `죽어` span 위협 HARD 검출). 전체 PASS 우회 재발 시 RED.

## 3. 서버 강제 경로 (정책 집행 핵심)

> raw를 DB에 남기고 UI만 `***` 처리는 **집행 아님**(public SELECT·구버전 앱 노출).

계약(선택지 제거·결정적):
1. **인증된 API route로 고정** — 채팅 전송을 `POST /api/chat/messages`(신설, TS 순수함수 `lib/chat/profanity/` 재사용)로 강제. RPC 안 씀.
2. **enforce HARD = 완전 거부 + raw 미보존**. 감사 로그는 **비원문 메타만**: `rule_id / action / filter_version / user_id / room_id / created_at`. **신규 HARD의 shadow 단계에서만 예외적으로 `message_id` 참조 로그**(수동 라벨링용, 원문 사본 저장 아님).
3. **`ingest_path`/`filter_version`은 서버 소유값** — 클라가 위조 못 하도록 서버에서 채워 기록(blocker rev0.5-②).
4. **idempotency 키 + 서버 rate-limit**(현행 클라 3초 쿨다운·60초/10건 서버 이관). **장애 시 direct insert fallback 금지**.
5. **direct insert 회수는 릴리스 2단계 분리**:
   - **P1a**: route + 클라 전환 + 서버 `ingest_path`/`filter_version` 기록. **기존 12어 enforce, 신규 HARD는 shadow 로그**. 배포 후 신·구 경로 트래픽 비율 관측.
   - **P1b**: direct insert 비율 **0 확인 후 별도 migration으로 RLS insert 정책 회수**.

## 4. 기술 접근 (오탐 방지 최우선)

- 정규화: 자모(`ㅅㅂ`)·반복문자(`씨이발`)·특수문자 삽입(`시,발`)·초성 우회 흡수(현행 로직 재사용·확장).
- 매칭: **어절/형태소 경계** 기준. HARD는 경계+정규화 후 판정, allowlist는 **span 단위 면책**(§1.5.2).
- 채팅 전용 순수 함수 모듈 `lib/chat/profanity/`로 분리 → 결정적 버전·회귀. 공용 `content-filter`는 미개변(타 UGC 비회귀).

## 5. SSOT

- **V1 = 코드 상수** SSOT(순수 함수·버전·회귀 결정적).
- 문서 SSOT = **Notion**(위 링크) + repo `specs/chat-profanity-filter.md`(exact SHA로 재리뷰).
- DB 튜닝(`term/category/action/version/audit` 테이블 + 검증·캐시)은 **P2**에서 개방.

## 6. 골든셋 (커밋 안전)

- 라벨: **비속어 후보 117 / 엄격 공격 26 / 정상 반례(오탐군)** + **우회 취약 2건**(`새끼손가락 ㅆ벌`·`강한남자 김경문 죽어`). 기존 48건 폐기.
- **운영 원문·닉네임 커밋 금지.** 합성·비식별 fixture만 저장소에(실 원문은 `state/qa/` 로컬).
- 결함주입 테스트로 오탐0(정상 반례 전건 통과) + 미탐(HARD 전건 검출) + 우회 무효화(전체 PASS 재발 시 RED) **다방향 게이트**.

## 7. 구현 순서 (얇은 수직 슬라이스)

- **P0 (삼순 조건부 GO — 착수 가능)** 채팅 전용 필터 코어(정규화+HARD 사전+span allowlist+어절 경계) 순수 모듈 + 합성 골든셋 회귀(오탐0·HARD 전건 검출·우회 무효화·타 UGC 비회귀).
- **P1a (HOLD)** `POST /api/chat/messages` 신설 → 채팅 경로 공용필터 교체 + 기존 12어 enforce + 신규 HARD shadow(`message_id`) 로그 + 서버 소유 `ingest_path`/`filter_version` + 문맥어 shadow. 종료 경기방 QA.
- **P1b (HOLD)** direct insert 비율 0 확인 → 별도 migration으로 RLS insert 회수.
- **P1.5 (HOLD)** shadow 오탐률 실측(§8) → 신규 HARD·문맥어 승격 판정. SOFT 승격 시 **서버 마스킹 저장·raw 미보존** 계약 확정(재리뷰).
- **P2** 관리자 대시보드(감지/신고 통계, DB 사전 튜닝 UI).
- **P3** 신고 가중·정책 확장.

## 8. 검증 / 게이트 (정량 정의)

- 합성 골든셋 회귀: **정상 반례군 오탐 0건**(하드 게이트, 미충족 시 머지 불가) + HARD 전건 검출 + 우회 무효화 mutation + **타 UGC(글/댓글/투표) 비회귀** + 결함주입 RED 확인.
- **오탐률 정의**: `FP / 전체 flagged`(shadow 로그에서 수동 라벨).
- **shadow→enforce/소프트 승격 게이트**: **최소 2개 전체 경기일 + 수동 라벨 100건 이상** 확보, 그 표본에서 **HARD 오탐 0 · 경로 우회 0 · 오탐률 < 1%**. 규칙별로 판정. 표본 미달이면 승격 금지(shadow 유지).
- **rollback = kill switch**: 전역 enforce→shadow 전환 스위치(서버 발급 런타임 플래그). 오탐 급증 시 코드 배포 없이 즉시 shadow로 강등.
- P1a E2E 게이트: `새끼손가락` 문장 PASS + 타 UGC 비회귀.
- P1b 완료 DoD: direct insert 회수(RLS insert 폐기) 실측.
- 종료된 과거 경기방/더미 room_id로만 QA(라이브 유저방 발송 금지 — P0).
- 삼순 리뷰 게이트 → 하린아빠 머지 승인.

## 9. 하린아빠 결정 완료 / 잔여

- ✅ HARD 저장 정책: **완전 거부 + raw 미보존, 비원문 메타만 감사 로그**(신규 HARD shadow 단계만 `message_id` 참조).
- 잔여: SOFT 서버 마스킹 저장 계약(P1.5 재리뷰). shadow→enforce 승격 시점 실측 후 재보고.
