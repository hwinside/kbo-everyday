# 경기 시작알림 cron 공백 복구 — Spec

- 상태: v2 CONFIRMED (하린아빠 결정 반영 완료, 구현 착수). PR 단계에서 삼순 코드 리뷰 게이트.
- 작성: 삼식이 (2026-07-26)
- 결정 로그: R1=1회초 첫타석전(payload-only) · R2=B(1-tick분리+앱 holdback) · R3=유실0(defer) · fanout=청크커서(A) · 성능=병렬발송+maxDuration상향
- 트리거 인시던트: 2026-07-26 18:00 KST 5경기 시작알림 전원 미발송(발송 0건)
- 관련 스레드: Slack #cs `1785056532.037769` ("경기시작알림 상태 체크")

---

## 1. 인시던트 (근본원인)

- 2026-07-26 18:00 KST 시작한 KBO 5경기 전부 "⚾ 경기 시작!" 푸시가 **한 명도 발송되지 않음**(`started=0`).
- 대상 규모: `profiles.team_id` 설정 + `game_start` 옵트인(기본 ON) ≈ **17,940명** (explicit opt-out 293 제외), 실제 기기토큰 보유 기준 최대 ~13,800대.
- 데이터 증거: `game_notify_state` 5경기 전부 `start_notified=true`, `last_seen_scheduled_at=2026-07-26T08:59:15Z`(17:59:15 KST), `updated_at≈09:02:46Z`(18:02:46 KST).

### 원인 체인
1. `game-events-warmup` cron(`vercel.json`: `* 5-14 * * *`, 분당 실행)이 **17:59:15 → 18:02:46 약 3.5분 공백**. 18:00·18:01·18:02 tick이 통째로 드롭됨.
   - 방아쇠: 경기 20분 전 프로덕션 3연속 배포(#852 ready 17:46 / #875 17:49 / #876 17:56) → Vercel 분당 크론은 best-effort(정시 실행 미보장), 배포 재바인딩·플랫폼 부하로 스킵/지연 발생, 하필 18:00 첫 구 시점에 겹침.
2. 18:02:46 재개 tick엔 5경기 모두 이미 라이브(1회초 진행 중).
3. `start-freshness-policy.ts`의 `shouldSendStartNotification()`이 "직전 tick 예정관측 연속성" 게이트(`SCHEDULED_SEEN_RECENT_MS = 90s`)를 적용 → `observedAt(18:02:46) - lastSeenScheduled(17:59:15) = 211s > 90s` → **5경기 전부 `markStart`(mark-only, 발송 스킵)**.
4. `markStart`가 `start_notified=true`로 마킹 → 이후 tick 재발송 불가.
5. 최애선수 첫 타석 안타(highlight/score 알림)는 신선도 게이트가 없어 **정상 배달** → 유저 체감: "안타는 오는데 시작알림만 안 옴".

> 성격: warmup 코드 자체 버그라기보단 **Vercel 크론 신뢰성 갭 + 시작알림 게이트의 all-or-nothing 억제(발송/억제를 `start_notified` 단일 비트에 종결)** 조합. 7/23·7/24 동일 계열.

---

## 2. 확정 요구사항 (하린아빠, 변경 불가)

- **(R1)** 시작알림 발송 허용 임계 = **"1회초 첫 타석이 끝나기 전"** 만. (가장 보수적 — 뒷북 오발송 리스크 ~0)
- **(R2) 순서 불변식**: 시작알림은 (그 경기에서 시작알림이 발송되는 한) **어떤 최애선수 활약알림(안타/홈런/득점 등)보다 반드시 먼저 도착**.
- **(R3) 유실 0**: 시작알림도, 초반(리드오프) 활약알림도 **둘 다 유실되면 안 됨**. 순서만 보장하고 둘 다 배달.

---

## 3. 설계

### 3.1 시작알림 상태 머신 (start_notified 단일 비트 폐기)

`game_notify_state` 시작 관련 컬럼을 상태 머신으로 승격:

```
idle ──(발송 자격 O, lease 선점)──▶ sending(lease_owner, claimed_at)
  │                                     │
  │                              (send 성공)──▶ sent(start_sent_at)
  │                                     │
  │                              (send 실패)──▶ idle (lease 만료 → 재시도)
  │
  └──(첫 타석 창 지남 = R1 불충족, 뒷북)──▶ suppressed(reason='past_first_at_bat')
```

- **`sent`(=`start_sent_at IS NOT NULL`)만** downstream(활약알림) 순서 게이트의 근거.
- `sending` lease: 겹친 cron invocation(75초 maxDuration 중첩) 중복발송 방지. **lease deadline = 45s**(크래시 후 회수 가능, 발송 중 정상 토큰 수면보다 길게).
- **신규 컴럼(확정)**: `game_notify_state`에 `start_state`('idle'|'sending'|'sent'|'suppressed'), `start_sent_at`, `start_lease_until`, `start_lease_owner`, `start_suppressed_reason`, `start_fanout_cursor`(청크 재개용) 추가. 기존 `start_notified`는 read-compat만(live-activity wake가 읽음) — 마이그레이션에서 과거 행 `start_state='sent'` 백필, 이후 SSOT는 `start_state`.
- `suppressed`: 정당하게 시작알림을 안 보내기로 확정한 상태(첫 타석 종료 후 재개). downstream 게이트를 **defer가 아니라 통과**시키는 신호.
- 하위호환: 기존 `start_notified=true` 행은 마이그레이션에서 `sent`(과거 발송분)로 간주 or 재평가 제외.

### 3.2 (R1) "1회초 첫 타석 끝나기 전" 판정 — payload-only (확정)

- **삼순 대행 판정 반영: 라인업/record 추가 fetch 불필요.** warmup이 이미 받는 경기 payload만으로 판정(외부 fetch 실패로 알림이 붕 뜨는 리스크 제거).
- **판정 기준 (첫 타석 미종결 창)**: `1회초 && 초(top) && 0아웃 && 양팀 0:0 && 1·2·3루 주자 없음`.
  - 근거: 첫 타석이 *끝나면* 반드시 아웃↑ / 주자 발생 / 득점 중 하나가 남는다 → 위 상태가 유지되는 동안만 "첫 타석 미종결"로 정확히 성립. (원정 1번타자 식별 없이도 상태로 판정 가능)
  - 사용 payload 필드(파서 확인 필요): `GAME_INN_NO`, `GAME_TB_SC`(초/말), 아웃카운트, 양팀 점수, 루상 주자(주자 baseOccupied/타순 필드).
- 하나라도 벗어나면(2번타자 진입=아웃/주자/득점 흔적, 이닝교체 등) → `suppressed(past_first_at_bat)`.
- ⚠️ 구현 확인: KBO live payload에 루상 주자 필드가 신뢰성 있게 있는지 파서에서 검증. 없으면 최소 `0아웃 && 0:0` + "직전 tick 대비 타자 1명만 관측" 보조 신호로 보강(단 payload-only 유지).

### 3.3 (R1) self-heal 재발송 — warmup 본체 재평가 (별도 크론 금지)

- self-heal은 **warmup 본체가 매 tick `idle`(또는 lease 만료된 `sending`)이고 R1 창이 열린 경기를 재평가**해 발송.
- **별도 Vercel 감시 크론 복제는 NO** — 사고 원인이 Vercel 분당크론 스킵인데 같은 플랫폼 크론 복제는 신뢰성 이득 0 + 중복·비용만 증가.
- 효과: 오늘처럼 첫 tick을 놓쳐도, 첫 타석 창이 아직 열려 있으면 다음 tick(≤1분 후)에 발송. 창이 이미 닫혔으면 `suppressed`.

### 3.4 (R2+R3) 순서 보장 = downstream **defer 게이트** (skip 아님)

- 활약/득점 알림(`game-score.ts`, `player-highlight.ts`)은 이미 **claim 기반 dedupe + defer 패턴** 보유:
  - `claimEvent(eventId)` → `onConflict event_id ignoreDuplicates`
  - 조건 미충족 시 `continue`(claim 안 함) → 이벤트는 event_history에 남아 **다음 tick 재평가**(유실 0).
- **게이트 추가**: 활약/득점 이벤트 처리 시 해당 경기 시작알림 상태가
  - `idle`/`sending`(=아직 발송 안 됨, 발송 예정) → **defer**(claim 안 함, 다음 tick 재평가). → 유실 0.
  - `sent` → 정상 발송(시작알림이 이미 나갔으므로 순서 OK).
  - `suppressed` → 정상 발송(그 경기는 시작알림 자체가 없으므로 순서 불변식 미적용). → 유실 0.
- **R2 강보장 = B (확정, 하린아빠 결정)**: FCM/APNs는 서버 발송순서 ≠ 기기 도착순서라 서버만으론 리터럴 순서 보장 불가. 따라서 2층 방어:
  1. **1-tick 분리(서버)**: "직전 tick에 `sent` 확정된 경기"만 downstream(score/highlight) 발송. 시작이 항상 최소 1 tick 앞서 나감. (같은 tick 내 start `idle/sending`이면 downstream defer → 다음 tick 재평가, 유실 0)
  2. **앱 클라이언트 holdback**: 해당 경기 시작알림을 아직 수신하지 않은 기기는 같은 경기의 활약알림 표시를 잠시 보류(시작카드 렌더 후 해제). 물리 도착순서가 역전되어도 화면 표시 순서 100% 보장.
  - 구현 노트: 활약알림 payload에 `gameId` + 서버 send-time 실어, 앱이 그 경기 시작카드 수신/렌더 여부로 gate. 미수신 지속시 짧은 timeout(예 8~10s) 후 강제 표시(유실 방지).

### 3.5 정합성 (R1 ∧ R2 ∧ R3 동시 성립)

| 상황 | 시작알림 | 초반 활약알림 | 순서 | 유실 |
|---|---|---|---|---|
| 첫 타석 창 안(정상 or 짧은 공백) | 발송(`sent`) | start 후 발송(defer→해제) | 시작 먼저 ✅ | 0 ✅ |
| 첫 타석 창 지남(큰 공백, 오늘 케이스) | 억제(`suppressed`) | 정상 발송 | 시작 없음(불변식 미적용) ✅ | 0 ✅ |

---

## 4. 엣지 케이스 / 리스크

- **겹친 cron(75초 maxDuration 중첩)**: `sending` lease로 중복발송 차단. lease 만료 회수 시 재발송이 실제 중복 안 되게 idempotency(예: 같은 게임 `start_sent_at` 존재 시 no-op) 유지.
- **활약알림 영구 defer 위험**: start가 `idle`에 영원히 머무르면 downstream이 영원히 defer → 유실. 방지: R1 창이 닫히는 순간 반드시 `sending`도 `suppressed`도 아닌 상태가 남지 않게 — "창 닫힘 감지 시 `idle`→`suppressed` 강제 전이"를 warmup가 보장.
- **우천 지연 시작**: 실제 개시 시점에 1회초로 관측되므로 R1 창 안 → 정상 발송(기존 정책 유지).
- **라인업 늦게 확정**: 1번타자 식별 전엔 발송 보류. self-heal이 확정 후 tick에 발송. 단 창이 그 사이 닫히면 `suppressed`(뒷북 방지 우선).
- **backfill/배포 직후 과거 경기**: 기존 "과거 날짜 mark-only" 가드 유지.

## 5. 테스트 계획 (회귀)

- `shouldSendStartNotification` → 상태 머신 전이 단위테스트: idle→sending→sent / idle→suppressed / lease 만료 회수 / 창 닫힘 강제 suppressed.
- (R1) 첫 타석 판정: 1번타자 진행중=발송, 2번타자·1아웃·1:0·이닝교체=suppressed. 라인업 미확정=defer.
- (R2/R3) downstream 게이트: start `idle`일 때 리드오프 안타 highlight가 **claim 안 됨(defer)** → 다음 tick start `sent` 후 발송됨(유실0, 순서). start `suppressed`면 highlight 즉시 발송.
- cron 공백 시뮬레이션: 17:59 예정관측 → 18:02 첫 관측(공백)에서 (창 열림)발송 / (창 닫힘)suppressed+highlight 발송.
- 겹친 invocation 중복발송 0.
- `qa:query-guard` / tsc / eslint / 대상 스모크 통과.

## 6. 운영룰 (별도, 코드 아님)

- **경기 시작 30~40분 전 프로덕션 배포 자제** — 오늘처럼 첫 구 직전 배포 몰림이 크론 스킵을 유발. `docs/team-rules.md` §4 배포 순서 + 위키에 명문화.

---

## 7. 오픈 이슈 (삼순 리뷰 게이트에서 결론)

1. (§3.2) 첫 타석 판정을 payload로 신뢰성 있게 구현 가능한지, 불가 시 안전 근사.
2. (§3.4 강보장 옵션) same-tick send 선후로 R2 충분한지 vs 1-tick 분리 필요.
3. (§3.1) lease deadline 값, `start_notified` 기존 행 마이그레이션 방식.
4. 상태 머신을 기존 `game_notify_state` 컬럼 확장으로 할지 신규 컬럼(`start_state`, `start_sent_at`, `start_lease_until`) 추가로 할지.

---

## 8. 성능 (병렬 fanout + maxDuration + 청크커서) — CS "업데이트/알림 느림" 직결

- 병목: FCM 아니라 **Vercel 서버리스 실행 봉투** — `maxDuration=75s`, 토큰 500개씩 *직렬* 발송(`deliverTokenChunks` for 루프). 주말 5경기 18:00 동시시작 → 한 tick이 5경기 fanout(~13,800토큰×5) 직렬이면 75s 초과 위험(오늘 실발송했어도 뒷경기 잘림 가능).
- **병렬 발송**: `deliverTokenChunks` 동시성 N(예 8~10, p-limit) → fanout 시간 1/N. 성공수 집계/무효토큰 정리 유지.
- **maxDuration 상향**: 75s → **300s**(Vercel Pro + Fluid Compute 기본, 최대 800s). 설정 변경.
- **청크커서(fanout durability, R3)**: `start_fanout_cursor`로 청크 진행 저장 → 크래시/타임아웃 시 그 지점부터 재개(유실0, 앞청크 소량 중복 가능성만). 한 tick 몰빵 방지.
- 무거운 fanout을 warmup 지연-크리티컬 경로(이벤트 캐시)와 분리.
- 중장기(유저 5~10만+): QStash 큐 or 전용 워커로 fanout 분리(별도 트랙, 이번 스코프 아님).

## 9. 슬라이싱 (얕은 수직 슬라이스, 빅뱅 금지)

- **S1 (P0 코어)**: 상태머신(신규 컬럼+마이그레이션) + (R1) payload 첫타석창 판정 → 신선도게이트 교체 + self-heal(warmup 재평가) + lease. → 오늘 같은 전원미수신 재발 차단.
- **S2 (R2/R3)**: downstream 1-tick 분리 defer 게이트(서버) + 앱 holdback(클라이언트).
- **S3 (성능)**: 병렬 fanout + maxDuration 300s + 청크커서 durability.
- 각 슬라이스 독립 PR → 삼순 리뷰 게이트(3왕복 자동루프). S1이 인시던트 직결 P0라 우선.
