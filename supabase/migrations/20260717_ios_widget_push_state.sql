-- iOS 홈 위젯 무음 갱신 (1.0.9 build 17, #product 1784295000.099849) — 앱 미실행 스코어 반영.
--
-- iOS 홈 화면 위젯은 WidgetKit 제약상 서버 push로 직접 갱신할 수 없다(LA와 달리 전용 push
-- 채널 없음). 대신 *스코어 변화 시에만* 무음(content-available) FCM으로 앱을 백그라운드
-- 깨워 위젯 스냅샷을 갱신한다(AppDelegate → WidgetSnapshotStore.markLiveScore → reload).
-- 매 틱이 아니라 스코어축 변화 시에만 발송 = iOS 백그라운드 push 예산 내(경기당 ~10-15회).
-- 3분 SLA는 아니고 best-effort(잠금화면 LA만 3분 보장). game_end 종료 전환은 기존 경로 유지.
--
-- 이 테이블 = 경기별 마지막 발송 스코어축 상태(다음 틱 무변화 스킵 판정). LA의
-- live_activity_game_push_state와 분리 — iOS 위젯 채널 전용(LA 스킵 로직과 독립).
create table if not exists ios_widget_push_state (
  game_id text primary key,
  last_score_state text not null,
  updated_at timestamptz not null default now()
);

alter table ios_widget_push_state enable row level security;
-- 정책 없음 = service_role 전용 (서버 크론만 접근)
