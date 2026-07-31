-- 검증된 인터뷰 전용 채널을 공식 중계사·구단 채널과 구분해 저장한다.
alter table postgame_interviews
  drop constraint if exists postgame_interviews_source_kind_check;

alter table postgame_interviews
  add constraint postgame_interviews_source_kind_check
  check (source_kind in ('broadcaster', 'team', 'curated'));
