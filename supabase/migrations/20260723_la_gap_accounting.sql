-- Live Activity 갱신불가(gap) 집계 교정 + 무음 wake 계측 (2026-07-23).
--
-- ① channel_born_environment / channel_born_channel_id: p2s 발송 시 payload에
--    input-push-channel(channelId)을 내장해 성공한 유저의 *채널 세대*를 기록.
--    채널 내장으로 태어난 카드(os18+/build16+)는 앱 wake 없이 broadcast로 갱신을
--    받는데, 어드민 대시보드는 *네이티브 채널 ACK*만 updatable로 인정해 build18
--    gap이 과대계상됐다(2026-07-23 실측 gap 1,727명 중 상당수 추정).
--    ⚠️ boolean 마킹이 아니라 (environment, channel_id) 세대를 기록하는 이유(삼순
--    라운드2 blocker): broadcast update가 ChannelNotRegistered를 받으면 active 행을
--    deleted로 바꾸고 다음 틱에 새 channel_id를 만드는 복구 경로가 있다
--    (live-activity-channels.ts). 채널 A로 태어난 카드는 A 무효화→B 교체 후 B
--    broadcast를 못 받으므로, "출생 채널이 지금도 active와 정확 일치"할 때만
--    updatable/wake 제외로 인정해야 한다. null(이 마이그레이션 이전 발송 행)은
--    backfill 불가 — 보수적으로 gap/wake 대상에 포함(종전과 동일 집계).
--
-- ③ wake_attempted_at: 무음 백그라운드 wake(pushLiveActivitySilentWakes) *첫* 시도 시각.
--    시도 후 update 토큰/채널 ACK가 등록되면(=updatable 전환) 구제 성공으로 집계 —
--    어드민 API가 wake 성공률을 노출한다. 새 테이블 없이 기존 선점 행에 붙여 최소 인프라.

alter table public.live_activity_started_users
  add column if not exists channel_born_environment text
    check (channel_born_environment in ('production', 'sandbox')),
  add column if not exists channel_born_channel_id text,
  add column if not exists wake_attempted_at timestamptz;
