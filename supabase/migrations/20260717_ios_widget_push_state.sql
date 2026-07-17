-- iOS 홈 위젯 무음 갱신 (1.0.9 build 17, #product 1784295000.099849) — 앱 미실행 스코어 반영.
--
-- iOS 홈 화면 위젯은 WidgetKit 제약상 서버 push로 직접 갱신할 수 없다(LA와 달리 전용 push
-- 채널 없음). 대신 *최초 live 1회 + 점수 변화 시에만* 무음(content-available) FCM으로 앱을
-- 백그라운드 깨워 위젯 스냅샷을 갱신한다(AppDelegate → WidgetSnapshotStore.markLiveScore).
-- 점수 축만 dedupe 키(경기당 ~10-25회) = iOS 백그라운드 push 예산 내(삼순 #674 blocker①).
-- 3분 SLA는 아니고 best-effort(잠금화면 LA만 3분 보장). game_end 종료 전환은 기존 경로 유지.
--
-- 이 테이블 = 경기별 마지막 발송 점수 상태(무변화 스킵 판정) + transient 실패 bounded retry
-- 카운터. claim/revert 모두 CAS(last_score_state 조건부 update)로 cron 중첩 중복 발송을 막는다.
create table if not exists ios_widget_push_state (
  game_id text primary key,
  last_score_state text not null,
  attempts int not null default 0,
  updated_at timestamptz not null default now()
);

alter table ios_widget_push_state enable row level security;
-- 정책 없음 = service_role 전용 (서버 크론만 접근)

-- build 17 게이트 (삼순 #674 blocker⑤) — widget_live 무음 push는 이 kind를 처리할 수 있는
-- 네이티브(build 17+)에만 발송해야 한다. 구버전에 보내면 처리 못 하는 wake로 silent push
-- 예산만 소모. 클라(원격로드 JS)가 register-device에 appBuild를 동봉하고 서버가 필터한다.
-- null = 미보고(구버전/웹) → gte 필터에서 자동 제외(fail-closed).
alter table device_push_tokens
  add column if not exists app_build int;
