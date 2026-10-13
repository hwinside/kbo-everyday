# 크관 relay 폴링 → Supabase Realtime 이관 (B안) — 확정 설계 SSOT

- PR: #1305 `feat/relay-realtime`
- 상태: 설계 확정 단계 (삼순 2026-08-25 17:47 "방향 조건부 GO, 초안 그대로는 NO")
- 이 문서 = 삼순 확정 설계 반영본. 구현 착수 전 삼순 리뷰 대상.
- ⚠️ 노션 SSOT 게시 blocker: 현재 `삼식이-싱크` 통합 토큰이 윤연률 워크스페이스에만 접근 가능(KBO 노션 페이지 404·미공유). 하린아빠가 KBO 노션에 통합 공유해주거나 본 로컬 파일을 SSOT로 승인 필요.

## 1. 문제

크관(경기 중계) relay 프레임이 클라이언트 폴링 + 분당 cron으로 upstream을 당겨 Vercel 호출 비용을 유발. B안 = publisher가 프레임을 테이블에 INSERT → 클라이언트는 `postgres_changes` 구독. Broadcast는 클라 스푸핑 가능이라 배제, service_role만 write.

## 2. 삼순이 지적한 correctness 결함 (초안 NO 사유)

핵심은 **cross-invocation overlap + stale-seq 순서 역전**:
- cron invocation A가 50초 budget/maxDuration 안에서 timeout 되어도 A의 INSERT가 서버측에서 계속 진행될 수 있음.
- 다음 분 invocation B가 시작 → B가 먼저 커밋(작은 id 아님, 오히려 A가 늦게 커밋되며 **더 큰 DB id**) → 클라이언트가 stale A를 최신으로 적용.
- `.abortSignal(signal)`은 Supabase 계약상 **fetch request signal 전달일 뿐** DB commit fence가 아님(client disconnect 후에도 PostgREST DB query 지속 가능).
- `Promise.allSettled(outstanding)`은 JS fetch promise만 대기 → correctness와 bounded execution(50초)을 동시에 보장 못 함.
- client seq ref만 추가하면 mount/reload 시 기준 seq가 0으로 리셋 → 재접속 클라가 늦은 A(seq1·큰 id)를 다시 적용.

→ 결론: JS 레벨 fence로는 durable ordering 불가. **DB 트랜잭션 내부에서 경기별 직렬화 + stale seq 원자 거부**가 유일한 correct 설계.

## 3. 확정 설계 (삼순 3가지 선택 반영)

### 3-1. DB RPC 원자 거부 — GO (단, 아래 교정 필수)
- **`pg_try_advisory_xact_lock`을 game 단위로** 사용. blocking `pg_advisory_xact_lock`은 "즉시 반환"이 아니므로 금지. lock 획득 실패 시 `lock_busy` 즉시 반환.
- **별도 durable cursor 테이블 필요.** frame `max(seq)`는 24h GC로 사라지므로 cursor를 `max(seq)`로 쓰면 안 됨. game(+channel)별 최신 커서를 별도 durable 행에 보관.
- **`relay-full` / `relay-delta` 둘 다 channel=`relay`로 묶기.** 현재 `kind` 조건은 stale full을 놓침. 커서 키는 channel 단위로 통일.

### 3-2. seq = commit 시 DB `max+1` — NO-GO
- 현 Redis `++seq` 단독도 부족(lease-loss 동률에서 first-commit-wins).
- 확정: **DB가 invocation 시작 시 monotonic writer epoch/range를 선예약** → Redis token 재확인 → publisher가 그 범위의 tick/channel ordinal 발급.
- RPC는 `(epoch, ordinal) <= channel cursor`를 **원자 거부**(stale). 커밋 시점 `max+1` 재계산 금지.

### 3-3. 클라이언트 정렬 — 현행 DB id 유지
- 위 RPC가 game-level xact lock 안에서 **cursor 갱신 + INSERT를 한 트랜잭션**으로 끝내면 id/commit 순서가 직렬화됨 → client seq 전환 불필요.

## 4. 구현 게이트 (삼순 요구)

- RPC는 `lock_busy` / `inserted` / `stale` **명시 반환**.
- **`security invoker` 우선.** 불가 시: empty `search_path` + schema-qualified 참조 + PUBLIC/anon/auth EXECUTE revoke.
- **unique 보조 제약** (epoch/ordinal 또는 (game, channel, ordinal) 유니크) 으로 이중 방어.
- 실제 PG **2세션 결함주입** 5축:
  1. B 선행 → A 거부
  2. A 선행 → B 최종
  3. 동률(tie) 처리
  4. `lock_busy` bounded (무한 대기 없음)
  5. **GC 후 cursor 보존** (24h GC로 frame 사라져도 cursor 유지 → 이후 stale 거부 계속 동작)

## 5. HOLD 계약

- 오늘/내일 라이브 = **A(현행 폴링) 유지.**
- migration · merge · deploy · cutover 전부 **HOLD.**
- cutover는 실전 1경기 shadow 계측 입증 후.
- 왕복 9회차 → 추가 임시패치 중단, 본 설계 확정 후 구현 착수.

## 6. 다음 액션

1. 본 설계 삼순 리뷰 (노션 게시 또는 로컬 SSOT 승인 대기).
2. 승인 시 migration(RPC + cursor 테이블 + unique 제약) → publisher/route epoch 선예약 → 결함주입 5축 → CI.
3. shadow 계측 → cutover 별도 승인.
