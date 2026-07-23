# 잠금화면 Live Activity — iOS 18 Broadcast Push 채널 전환 스펙 v4

> 2026-07-16 하린아빠 지시 "근본으로 바로 가자" (#cs `1784203900.246869`).
> v2 (21:55): 삼순 1차 blocker 4건(환경·이중 경로 SSOT·p2s 조건·종료 retention) 반영.
> v3 (22:06): 삼순 2차 blocker 3건(ACK 스키마/검증·env 선택 프로토콜·end backoff) 반영.
> v4 (22:1x): 삼순 3차 blocker 3건(env=null per-attempt 규칙 통합·attributes channelId marker ACK·register-start 메타 배선/빌드상수 env) 반영. end backoff는 v3에서 해소 확인.
> v4 원문 정정 (7/17 00:2x, 삼순 조건부 GO 잔여 2건): deviceKey 서버 derive + ACK 재시도 범위 확정 / 레거시 판정 NOT EXISTS 명문화.
> 배경: 매분 per-토큰 priority-10 update가 iOS LA 예산을 경기 +2h쯤 소진 → 잠금 중 갱신 스로틀(7/16 하린아빠 실기기 확정). 서버·토큰·APNs 전 구간 정상 실측.

## 목표
- 경기당 APNs broadcast 채널로 전 유저 잠금 카드 동시 갱신 → per-디바이스 예산 개념 제거.
- iOS 18 미만·구빌드는 기존 per-토큰 경로 유지(이중 경로). 어떤 유저도 지금보다 나빠지지 않음.

## Apple API 실사양 (2026-07 문서 기준)
- **채널 관리 호스트/포트 (v2 정정)**: `api-manage-broadcast.push.apple.com` — **sandbox `:2195` / production `:2196`**. 환경별로 별개 네임스페이스(같은 game이라도 env마다 채널 별도).
- **채널 생성**: `POST .../1/apps/fan.keubo.app/channels`, JWT(기존 APNS p8 재사용), body `{"message-storage-policy": 0, "push-type": "LiveActivity"}` → 201 + `apns-channel-id`(base64) 응답 헤더. 스포츠(고빈도)는 No-Message-Stored(=0) 권장 — 발행 예산 상향. 이 정책이면 발송 시 `apns-expiration: 0` 필수.
- **브로드캐스트 발송**: `POST https://api-broadcast.push.apple.com/4/broadcasts/apps/fan.keubo.app`(sandbox는 sandbox 호스트), 헤더 `apns-push-type: liveactivity`, `apns-channel-id`, `apns-priority`, `apns-expiration: 0`. payload = 기존 update/end와 동일 aps 구조, ≤5KB.
- **클라 구독**: iOS 18+ `Activity.request(..., pushType: .channel(channelId))`. 유효하지 않은 채널이면 start 실패.
- **p2s 조합**: p2s payload에 `"input-push-channel": <channelId>` 추가 → 시작된 activity가 채널 구독(iOS 18+). ⚠️ iOS 17 이하 기기에 이 payload를 보내면 start 자체가 실패.
- **한도/수명**: 앱당 채널 10,000개(env별). 채널 수명은 activity와 독립 — 명시 DELETE 필요.
- **broadcast로 start 불가** — start는 여전히 p2s per-디바이스.
- **선행 조건**: developer.apple.com > Identifiers > fan.keubo.app > Push Notifications **Broadcast Capability 활성화**(포털 전용, 끄면 전 채널 무효화 — 켠 뒤 유지).

## 설계

### 서버 (Slice A)
1. 신규 테이블 `live_activity_channels` — **PK `(game_id, environment)`** (v2 blocker①). 컬럼: `game_id, environment('production'|'sandbox'), channel_id, status('active'|'ending'|'deleted'), last_state_hash, last_score_state, created_at, ending_at, deleted_at`.
2. warmup 크론: start 윈도우 진입 시 env별 채널 생성·저장(멱등: active 행 있으면 재사용). 관리 포트 = env에 따라 2195/2196.
3. **start 토큰 환경 저장 (v2 blocker①)**: `live_activity_start_tokens.apns_environment` 신설(기존 발송 코드의 prod→sandbox 폴백 재시도 결과를 기록). p2s에 `input-push-channel`을 넣을 땐 *그 토큰의 env와 일치하는 채널 ID*를 사용 — 반대 호스트 재시도 시 채널 ID도 해당 env 것으로 교체.
4. **구독 SSOT (v3 blocker① 재설계)**: APNs 200은 접수 증명일 뿐이므로 서버측 추정 마킹 전면 폐기 — **네이티브 ACK만 SSOT**. 신규 테이블 `live_activity_channel_subscriptions(game_id, user_id nullable, device_key, environment, channel_id, confirmed_at)` (unique: game_id+device_key+environment).
   - **인앱 `.channel` start 성공 시**: 클라가 activity 생성 성공 직후 `POST /api/live-activity/channel-ack {gameId, channelId, environment, pushToStartToken}` 호출(로그인 세션 있으면 user_id 병기). **`deviceKey`는 클라 입력값을 신뢰하지 않음 — 서버가 검증된 `pushToStartToken`에서 derive(해시)** (조건부 GO 정정①).
   - **p2s 경로 ACK 증명 (v4 blocker②)**: Activity API는 시작 pushType/채널을 조회할 수 없으므로 `activityUpdates` 감지만으로 ACK 금지(레거시 start 오인). **channel p2s payload에만 static attributes에 `channelId` marker를 실어 보내고**, 클라는 감지한 activity의 attributes에서 marker를 읽어 *현재 active 채널과 일치할 때만* ACK 호출. 레거시 p2s payload에는 marker 부재 → ACK 안 함.
   - **ACK device-auth**: 로그인 세션 없을 수 있으므로 그 기기 `pushToStartToken` 제출 → 서버가 `live_activity_start_tokens` 실존 검증 후 수락(위조 차단). APNs 200만으로는 절대 마킹하지 않음.
   - **ACK 내구성 (v4 blocker② + 조건부 GO 정정①)**: ACK 전송 실패 시 클라가 로컬 persist(UserDefaults 큐) 후 앱 활성 시 재시도 — 단 **재시도 대상은 network 오류·5xx만. stale channel·invalid token 등 4xx는 즉시 폐기(+큐 항목 TTL)로 영구 큐 방지**(멱등: unique 제약으로 중복 무해).
   - **레거시 제외·stale 토큰 삭제 조건**: 해당 subscription의 `channel_id`가 *그 env의 현재 active 채널과 일치*할 때만. 불일치(지난 경기 채널 등)면 레거시 경로 유지.
   - silent-wake gap 계산·중복 start 판정도 동일 조건으로 subscription 확인 유저만 제외.
5. `pushLiveActivityUpdates` 이중 경로:
   - **채널 경로**: 라이브 경기당 env별 broadcast(update) 발송. **priority 10/5 판정 (v2 blocker④)**: `last_score_state`(점수/이닝/주자 hash)와 비교 — 변화 있으면 10, 볼카운트/타자만 변하면 5, 완전 무변화 틱 스킵. 판정용 이전 state/hash는 `live_activity_channels`에 저장.
   - **레거시 경로 (조건부 GO 정정②)**: 기존 per-토큰 발송 유지, 대상 = **그 env의 현재 active 채널과 일치하는 subscription이 `NOT EXISTS(game_id + user_id/device_key + environment + channel_id)`인 토큰**(`via_channel` 불리언 표현 폐기). 동일 priority 10/5 믹스 적용(iOS 16/17·구빌드 유저도 예산 완화).
6. **종료 시퀀스 (v3 blocker③ 정정)**: 경기 종료 → end broadcast + `status='ending'`, `ending_at=now`. 매분 재발송 금지(8h×매분=480회로 채널 예산 재소진) — `live_activity_channels`에 `next_retry_at, attempt_count` 추가, **backoff 재시도: 즉시→1m→5m→15m→30m→이후 1h 간격**(경기당 총 ~13회). 8h 경과 후 채널 DELETE + `status='deleted'`. 주간 잔존 sweep 병행.
7. **채널 조회/env 선택 (v3 blocker②)**: `GET /api/live-activity/channel?gameId=` 는 **양쪽 env의 channel id를 모두 반환** `{production: ..., sandbox: ...}`(비로그인 허용, 읽기 전용). **인앱 선택 = 클라가 자기 빌드의 `aps-environment` entitlement 값으로 명시 선택**(TestFlight/App Store=production, Xcode 디버그=development→sandbox) — 익명 GET이 env를 추정하지 않음. **p2s는 `apns_environment=null`이어도 `시도 host ↔ 동일 env channelId` 쌍 불변식 유지**: prod host+prod 채널ID로 발송 → `BadDeviceToken`이면 sandbox host+sandbox 채널ID 쌍으로 재시도 → 성공한 env를 `live_activity_start_tokens.apns_environment`에 저장(이후 고정). 교차 쌍(prod host+sandbox 채널 등) 발송 금지.

### iOS 클라 (Slice B, 빌드 16)
1. **register-start 메타 배선 (v4 blocker③)**: 현 `/api/live-activity/register-start`는 token만 저장 — `live_activity_start_tokens`에 `app_build`, `os_major` 컴럼 신설 + 클라 보고·서버 저장 배선을 Slice A/B에 명시(기존 update 토큰 경로의 app_build 배선과 별개임에 주의).
2. 인앱 start: iOS 18+ && 채널 조회 성공 → 자기 env의 channel id로 `pushType: .channel` + 성공 시 channel-ack 호출(§서버 4). 실패/미만 → 기존 `.token` 폴백. **env 판정 = 런타임 entitlement 읽기가 아니라 네이티브 build-config 상수**(v4 blocker③: `#if DEBUG → sandbox / else → production` 컴파일타임 상수 — entitlement 파일은 런타임 조회 불가·불안정).
3. `.channel` activity는 update 토큰 등록 스킵. p2s로 시작된 `.channel` activity도 감지 시 device-auth ACK 호출(§서버 4).
4. `frequentPushesEnabled` 등록 시 보고(진단용, 행동 무변화).

### 관제 (Slice C, 소형)
- `/admin/live-activity`(#578)에 경기별 채널 상태(env·status·broadcast 발송 수·구독 확인(subscription) 수) 1행 추가.

### iOS 클라 (Slice D — 레거시 카드 포그라운드 마이그레이션, 2026-07-23 P0)
> 배경: 7/23 아침 파서 장애로 채널이 19:07에야 생성 → 경기 시작 때 뜬 카드 전부 레거시(per-토큰)로 태어남. iOS는 기존 activity의 push 방식 변경 불가 + 레거시 갱신은 예산 스로틀 → 카드가 이닝 단위 지연, *앱을 열어도 복구 안 됨*(rescan이 update 토큰 재등록만 함).
1. 매 포그라운드 `rescanActiveActivities()`에서 activity별 마이그레이션 판정 — 순수 정책 `ChannelMigrationPolicy`(스모크 `qa:la-migration-policy` 고정): iOS 18+ && marker(`attributes.channelId`) 부재(레거시) && 라이브(`status == .live` && `activityState == .active`) && 성공 이력·in-flight 없음 → GET `/api/live-activity/channel`로 자기 env active 채널 조회.
2. **재생성 우선 순서(안전 원칙)**: active 채널 확보 시 *먼저* `Activity.request(pushType: .channel, attributes+marker)`로 현재 contentState 그대로 채널 카드를 재생성하고, **성공한 뒤에만** 같은 경기 레거시 카드를 `.immediate` end. fetch 실패/채널 부재/request 실패 = 레거시 유지 no-op — 어떤 경로에서도 카드만 사라지지 않는다.
3. 재생성 성공 시 기존 ACK 경로(`ackChannelActivity` — active 재검증·persist 큐·device-auth) 재사용으로 구독 SSOT 기록. 서버 레거시 발송 제외(§서버 5 NOT EXISTS)도 그대로 작동해 per-토큰 발송이 자연 중단된다. 서버 변경 없음.
4. 재시도 정책: 채널 부재(definitive)·GET 일시 실패도 폐기 아닌 유보 — 완료 마킹 없이 다음 포그라운드에서 재시도(채널이 늦게 생기는 7/23 케이스 커버). 성공만 경기당 1회 마킹, 동시 중복은 in-flight 가드.
5. **R2(삼순 blocker 반영, 2026-07-23)**:
   - **경기 단위 직렬화**: `start()`·migration·`end()`는 경기별 Task 체인(`withGameSerialQueue`)에서 상호 배제. start()의 정리 스윕은 같은 경기 카드 중 *채널 카드(marker)를 최우선 보존*(`keepIndex`) — 카드가 있으면 반드시 한 장 보존(카드 0장 경로 없음).
   - **중복 채널 방지**: 직렬 구간에서 같은 경기 active 채널 카드가 이미 있으면 신규 `request` 없이 legacy만 정리(`migrateMode = adopt`). `migrated` 마킹은 새 카드 active 확인 + legacy 정리 완료 *후*에만.
   - **background request 0**: 마이그레이션은 `applicationDidBecomeActive`(foreground-active) 전용 진입점 `migrateLegacyActivitiesOnForeground()`에서만 실행. silent wake(`didReceiveRemoteNotification`)의 rescan은 토큰 재등록만 — local `Activity.request()` 0건. 직렬 구간에서도 request 직전 `recheck`로 background 전환·legacy 소멸을 재검증.
   - **레거시 fallback 차단(build16+/iOS18+)**: 신규 `start()`는 채널 카드만 생성(`startDecision`) — 채널 미준비/GET 일시 실패/request 실패 = 시작 유보(다음 기회 재시도), 기존 `.token` fallback 분기 제거. iOS 17 이하는 `isEnabled`(18 게이트)로 start 자체 no-op, build 15 이하 구버전 바이너리 레거시 경로는 불변.

## p2s `input-push-channel` 포함 규칙 (v4 통합 — per-attempt 단일 규칙)
**게이트(토큰 단위)**: `os_major>=18 && app_build>=16`(둘 다 클라 명시 보고값). 미충족/미보고 → 기존 payload(레거시).
**env는 게이트가 아니라 per-attempt 규칙** (v4 blocker① 모순 해소 — env=null 기존 토큰도 채널 경로 진입 가능):
- `apns_environment` known → 그 env 쌍(host+동일 env active 채널ID)으로만 발송. 그 env에 active 채널 없으면 기존 payload.
- `apns_environment=null` → attempt1 = prod host+prod 채널ID → `BadDeviceToken` 시 attempt2 = sandbox host+sandbox 채널ID → 성공한 env 저장·이후 고정. 각 attempt에서 해당 env active 채널이 없으면 그 attempt는 기존 payload로 발송.
- 불변식: 어떤 attempt에서도 `발송 host의 env == 포함 channelId의 env`. 교차 쌍 금지.

## 마이그레이션/호환 매트릭스 (v2 정정)
- 신빌드(16+) + iOS18+: start = p2s(input-push-channel) 또는 인앱 `.channel` / update = broadcast.
- 구빌드(≤15) + iOS18+: 기존 p2s / per-토큰(priority 믹스) — os_major 미보고라 자동 레거시.
- iOS<18 (빌드 무관): **현 클라 게이트상 LA 자체 미지원 — 변화 없음.** (v1 매트릭스의 "신빌드+iOS<18 per-token" 행은 오류였음 → 정정. per-토큰 레거시 경로의 실수요 = 구빌드 iOS18+ 유저)

## 리스크
- Broadcast Capability 포털 토글 = 하린아빠 선행 작업. 끄면 전 채널 무효화 — 켠 뒤 유지.
- env 불일치(채널은 prod인데 토큰은 sandbox 등) → blocker① 설계(env별 채널 + 토큰 env 기록)로 구조적 차단. 유닛으로 매트릭스 검증.
- 채널 10,000 한도: ending→retention→DELETE + 주간 sweep으로 방어.
- Apple 발행 예산(채널)도 무한 아님 — No-Message-Stored + 무변화 틱 스킵으로 여유 확보.

## 검증 계획
- 서버: sandbox(2195) 채널 생성/발송/ending/삭제 실측(curl) + 경로 분기·env 매트릭스·priority 판정 유닛.
- 실기기: 하린아빠 iPhone(iOS 18+) TestFlight 빌드 16 — 채널 구독 카드가 잠금 2h+ 방치에도 매분 갱신(이번 재현 조건 그대로) = 합격 기준.
- 레거시 회귀: 구빌드(15) 실기기/시뮬 per-토큰 경로 무변경 + priority 믹스 적용 확인. end 재시도: 비행기모드 30분 후 복귀 단말이 end 수신하는지.
