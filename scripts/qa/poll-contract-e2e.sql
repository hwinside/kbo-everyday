\set ON_ERROR_STOP on
-- ============================================================
-- 커뮤니티 투표(Poll) S1 — 서버 계약 E2E (spec specs/community-poll.md §7 ①–⑩)
-- runner(poll-contract-e2e.sh)가 throwaway 로컬 pg 에 bootstrap+migration 적용 후 실행.
-- 각 블록은 DO/RAISE 로 assert; 실패 시 FAIL 로 abort. 운영 DB 무관.
-- ============================================================

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
ON CONFLICT DO NOTHING;

-- ---------- create_poll 검증 ----------
DO $$
DECLARE v_pid bigint;
BEGIN
  BEGIN
    PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','mix?',null,false,now()+interval '1 day',
      '[{"kind":"team","ref_id":"lg"},{"kind":"player","ref_id":"69100"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: team+player coexist accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','mix2?',null,false,now()+interval '1 day',
    '[{"kind":"team","ref_id":"lg"},{"kind":"etc","label":"기권"}]'::jsonb);
  IF v_pid IS NULL THEN RAISE EXCEPTION 'FAIL: team+etc rejected'; END IF;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day',
    '[{"kind":"etc","label":"only"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: 1 option accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day',
    (SELECT jsonb_agg(jsonb_build_object('kind','etc','label','o'||g)) FROM generate_series(1,11) g));
    RAISE EXCEPTION 'FAIL: 11 options accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '5 min',
    '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: closes<10min accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '31 days',
    '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: closes>30d accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day',
    '[{"kind":"etc","label":""},{"kind":"etc","label":"b"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: etc empty label accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day',
    '[{"kind":"team"},{"kind":"team","ref_id":"ob"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: team missing ref_id accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day',
    '[{"kind":"team","ref_id":"lg"},{"kind":"team","ref_id":"lg"}]'::jsonb);
    RAISE EXCEPTION 'FAIL: duplicate team ref_id accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  RAISE NOTICE 'PASS create_poll validations (coexist/mix/count/closes/etc/ref_id/duplicate ref)';
END $$;

-- ---------- poll posts direct write guard (삼순 2차 blocker #1) ----------
-- create_poll 은 별도 autocommit transaction 에서 정상 성공해야 하고, 이후 authenticated
-- direct path 에서는 투표 전 poll→free 변경과 child 없는 phantom poll INSERT 모두 거부한다.
SELECT create_poll(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','pre-vote immutable?',null,false,
  now()+interval '1 day',
  '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb
) AS direct_guard_pid \gset
SELECT set_config('poll.direct_guard_pid', :'direct_guard_pid', false);

SET ROLE authenticated;
-- posts owner UPDATE RLS(harness) 통과를 위해 작성자 identity 설정 → 그래야 트리거가 발화해
-- board_type/board_id 변경·phantom INSERT 를 check_violation 으로 거부하는지 검증된다.
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE
  v_pid bigint := current_setting('poll.direct_guard_pid')::bigint;
  v_free bigint;
BEGIN
  BEGIN
    UPDATE posts SET board_type='free' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL direct guard: pre-vote poll→free accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE posts SET board_id='free' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL direct guard: pre-vote poll board_id change accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    INSERT INTO posts(author_id,board_type,board_id,title,content)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','poll','poll','phantom','');
    RAISE EXCEPTION 'FAIL direct guard: phantom poll INSERT accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  INSERT INTO posts(author_id,board_type,board_id,title,content)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','team','lg','ordinary','')
  RETURNING id INTO v_free;
  BEGIN
    UPDATE posts SET board_type='poll', board_id='poll' WHERE id=v_free;
    RAISE EXCEPTION 'FAIL direct guard: non-poll→poll accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;

  IF (SELECT board_type FROM posts WHERE id=v_pid) <> 'poll' THEN
    RAISE EXCEPTION 'FAIL direct guard: legitimate poll type mutated';
  END IF;
  RAISE NOTICE 'PASS direct guard: create_poll succeeded; authenticated pre-vote type/board change + phantom INSERT + non-poll→poll rejected';
END $$;
RESET ROLE;

-- ---------- ① RLS: direct SELECT + RPC EXECUTE 차단 ----------
DO $$
DECLARE v_pid bigint;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','who wins?',null,false,now()+interval '1 day',
    '[{"kind":"team","ref_id":"lg"},{"kind":"team","ref_id":"ob"}]'::jsonb);
  PERFORM set_config('poll.pid', v_pid::text, false);
END $$;

SET ROLE authenticated;
DO $$
DECLARE blocked int := 0;
BEGIN
  BEGIN PERFORM 1 FROM poll_polls;   EXCEPTION WHEN insufficient_privilege THEN blocked:=blocked+1; END;
  BEGIN PERFORM 1 FROM poll_options; EXCEPTION WHEN insufficient_privilege THEN blocked:=blocked+1; END;
  BEGIN PERFORM 1 FROM poll_votes;   EXCEPTION WHEN insufficient_privilege THEN blocked:=blocked+1; END;
  IF blocked <> 3 THEN RAISE EXCEPTION 'FAIL ①: direct SELECT not fully blocked (%/3)', blocked; END IF;
  RAISE NOTICE 'PASS ① authenticated direct SELECT blocked on 3 tables';
END $$;
DO $$
DECLARE blocked int := 0;
BEGIN
  BEGIN PERFORM cast_poll_vote(current_setting('poll.pid')::bigint,'11111111-1111-1111-1111-111111111111',ARRAY[1::bigint]);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=blocked+1; WHEN others THEN NULL; END;
  BEGIN PERFORM create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','x',null,false,now()+interval '1 day','[]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN blocked:=blocked+1; WHEN others THEN NULL; END;
  IF blocked <> 2 THEN RAISE EXCEPTION 'FAIL ①: RPC EXECUTE not blocked (%/2)', blocked; END IF;
  RAISE NOTICE 'PASS ① authenticated cannot EXECUTE create_poll/cast_poll_vote';
END $$;
RESET ROLE;

-- ---------- ②⑤ 투표 + 변경(이전표 소멸·중복0) ----------
DO $$
DECLARE v_pid bigint; o1 bigint; o2 bigint; vc1 int; vc2 int; vcnt int; nvotes int;
BEGIN
  v_pid := current_setting('poll.pid')::bigint;
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  SELECT id INTO o2 FROM poll_options WHERE post_id=v_pid ORDER BY position DESC LIMIT 1;
  PERFORM cast_poll_vote(v_pid,'11111111-1111-1111-1111-111111111111',ARRAY[o1]);
  SELECT vote_count INTO vc1 FROM poll_options WHERE id=o1;
  SELECT voter_count INTO vcnt FROM poll_polls WHERE post_id=v_pid;
  IF vc1<>1 OR vcnt<>1 THEN RAISE EXCEPTION 'FAIL ②: vc1=% voter=%',vc1,vcnt; END IF;

  PERFORM cast_poll_vote(v_pid,'11111111-1111-1111-1111-111111111111',ARRAY[o2]);
  SELECT vote_count INTO vc1 FROM poll_options WHERE id=o1;
  SELECT vote_count INTO vc2 FROM poll_options WHERE id=o2;
  SELECT count(*) INTO nvotes FROM poll_votes WHERE post_id=v_pid AND user_id='11111111-1111-1111-1111-111111111111';
  SELECT voter_count INTO vcnt FROM poll_polls WHERE post_id=v_pid;
  IF vc1<>0 OR vc2<>1 OR nvotes<>1 OR vcnt<>1 THEN
    RAISE EXCEPTION 'FAIL ⑤: o1=% o2=% nvotes=% voter=%',vc1,vc2,nvotes,vcnt; END IF;
  IF (SELECT first_vote_at FROM poll_polls WHERE post_id=v_pid) IS NULL THEN
    RAISE EXCEPTION 'FAIL: first_vote_at not set'; END IF;
  RAISE NOTICE 'PASS ②⑤ vote + change replaces old ballot (no dup), counts consistent, first_vote_at set';
END $$;

-- ---------- 단일선택 상한 + 빈 + 중복 ----------
DO $$
DECLARE v_pid bigint; o1 bigint; o2 bigint;
BEGIN
  v_pid := current_setting('poll.pid')::bigint;
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  SELECT id INTO o2 FROM poll_options WHERE post_id=v_pid ORDER BY position DESC LIMIT 1;
  BEGIN PERFORM cast_poll_vote(v_pid,'22222222-2222-2222-2222-222222222222',ARRAY[o1,o2]);
    RAISE EXCEPTION 'FAIL: single-select accepted 2'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM cast_poll_vote(v_pid,'22222222-2222-2222-2222-222222222222',ARRAY[]::bigint[]);
    RAISE EXCEPTION 'FAIL: empty accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN PERFORM cast_poll_vote(v_pid,'22222222-2222-2222-2222-222222222222',ARRAY[o1,o1]);
    RAISE EXCEPTION 'FAIL: duplicate accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS single-select cap + empty + duplicate rejected';
END $$;

-- ---------- 복수선택 N표 허용 ----------
DO $$
DECLARE v_pid bigint; o1 bigint; o2 bigint; nv int;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','multi?',null,true,now()+interval '1 day',
    '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"},{"kind":"etc","label":"c"}]'::jsonb);
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  SELECT id INTO o2 FROM poll_options WHERE post_id=v_pid ORDER BY position OFFSET 1 LIMIT 1;
  PERFORM cast_poll_vote(v_pid,'11111111-1111-1111-1111-111111111111',ARRAY[o1,o2]);
  SELECT count(*) INTO nv FROM poll_votes WHERE post_id=v_pid AND user_id='11111111-1111-1111-1111-111111111111';
  IF nv<>2 THEN RAISE EXCEPTION 'FAIL multi: nv=%',nv; END IF;
  RAISE NOTICE 'PASS multi-select allows N votes';
END $$;

-- ---------- ⑦ 타 poll 옵션 거부 (RPC + 복합 FK) ----------
DO $$
DECLARE v_pidA bigint; v_pidB bigint; optB bigint;
BEGIN
  v_pidA := current_setting('poll.pid')::bigint;
  v_pidB := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','B?',null,false,now()+interval '1 day',
    '[{"kind":"etc","label":"b1"},{"kind":"etc","label":"b2"}]'::jsonb);
  SELECT id INTO optB FROM poll_options WHERE post_id=v_pidB ORDER BY position LIMIT 1;
  BEGIN PERFORM cast_poll_vote(v_pidA,'33333333-3333-3333-3333-333333333333',ARRAY[optB]);
    RAISE EXCEPTION 'FAIL ⑦: cross-poll accepted (RPC)'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  BEGIN INSERT INTO poll_votes(post_id,option_id,user_id) VALUES (v_pidA,optB,'33333333-3333-3333-3333-333333333333');
    RAISE EXCEPTION 'FAIL ⑦: cross-poll raw insert accepted (FK)'; EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  RAISE NOTICE 'PASS ⑦ cross-poll option rejected (RPC guard + composite FK)';
END $$;

-- ---------- ④ 마감 후 write 거부 ----------
DO $$
DECLARE v_pid bigint; o1 bigint;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','closing?',null,false,now()+interval '20 min',
    '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb);
  UPDATE poll_polls SET closes_at = now()-interval '1 min' WHERE post_id=v_pid; -- no first vote → allowed
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  BEGIN PERFORM cast_poll_vote(v_pid,'11111111-1111-1111-1111-111111111111',ARRAY[o1]);
    RAISE EXCEPTION 'FAIL ④: closed poll accepted vote'; EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS ④ closed poll rejects vote (fail-closed server time)';
END $$;

-- ---------- ⑨ 첫 투표 후 편집 잠금 ----------
DO $$
DECLARE v_pid bigint; o1 bigint;
BEGIN
  v_pid := current_setting('poll.pid')::bigint; -- has votes (first_vote_at set)
  -- (1) 2026-07-28 완화: title/content 는 첫 투표 후에도 수정 성공해야 함(하린아빠 결정).
  UPDATE posts SET title='edited-question' WHERE id=v_pid;
  UPDATE posts SET content='edited-desc' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'edited-question'
     OR (SELECT content FROM posts WHERE id=v_pid) <> 'edited-desc' THEN
    RAISE EXCEPTION 'FAIL ⑨: title/content edit after first vote did not persist'; END IF;
  -- (2) 선지·마감·allow_multiple 은 계속 차단.
  BEGIN INSERT INTO poll_options(post_id,position,kind,label_snapshot) VALUES (v_pid,9,'etc','sneak');
    RAISE EXCEPTION 'FAIL ⑨: option insert accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  BEGIN UPDATE poll_options SET label_snapshot='x' WHERE id=o1;
    RAISE EXCEPTION 'FAIL ⑨: option structure update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM poll_options WHERE id=o1;
    RAISE EXCEPTION 'FAIL ⑨: option delete accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE poll_polls SET allow_multiple=true WHERE post_id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨: allow_multiple update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE poll_polls SET closes_at=now()+interval '99 days' WHERE post_id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨: closes_at update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'PASS ⑨ edit-policy: title/content editable; option add/remove/struct, allow_multiple, closes_at blocked';
END $$;

-- ---------- N3 삼순 NO-GO probe: voted poll 비텍스트 작성자 필드 불변 ----------
-- 삼순이 PG17+RLS probe 로 재현한 경로: 첫 투표 후 작성자가 직접 UPDATE 로
-- content_type/image_urls/seat_info/video_urls 를 바꿔 voted poll 무결성 훼손.
-- 트리거가 title/content 이외 작성자 제어 필드를 전부 check_violation 으로 거부해야 한다.
DO $$
DECLARE v_pid bigint;
BEGIN
  v_pid := current_setting('poll.pid')::bigint; -- has votes (first_vote_at set)
  BEGIN UPDATE posts SET content_type='photo' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: content_type change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET image_urls='["https://attacker.invalid/x.jpg"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: image_urls change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET video_urls='["https://attacker.invalid/v.mp4"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: video_urls change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET seat_info='{"zone":"forged"}'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: seat_info change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  -- 결합 UPDATE(삼순 원 probe 형태: 한 번에 여러 비텍스트 필드)도 거부.
  BEGIN UPDATE posts SET content_type='photo', image_urls='["https://attacker.invalid/x.jpg"]'::jsonb,
                         seat_info='{"zone":"forged"}'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: combined non-text field change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  -- 비텍스트 필드는 전혀 바뀌지 않았어야 함.
  IF (SELECT content_type FROM posts WHERE id=v_pid) = 'photo'
     OR (SELECT image_urls::text FROM posts WHERE id=v_pid) LIKE '%attacker.invalid%'
     OR (SELECT seat_info::text FROM posts WHERE id=v_pid) LIKE '%forged%' THEN
    RAISE EXCEPTION 'FAIL N3: non-text field mutated despite reject'; END IF;
  -- 삼순 NO-GO(2): allowlist 가 denylist 를 대체했으므로, 명시 바깥에 있던 스키마
  -- 컬럼(game_id/hashtags/author_team_id_snapshot/created_at 등)도 voted poll 에서 불변이어야 함.
  BEGIN UPDATE posts SET game_id='20260728HACK' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: game_id change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET hashtags='["hacked"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: hashtags change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET author_team_id_snapshot=99 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: author_team_id_snapshot change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET created_at=now()-interval '10 years' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3: created_at change on voted poll accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  -- title/content 는 그래도 수정 가능(계약 유지).
  UPDATE posts SET title='q-after-probe', content='c-after-probe' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'q-after-probe' THEN
    RAISE EXCEPTION 'FAIL N3: title still editable after probe'; END IF;
  RAISE NOTICE 'PASS N3 voted poll: non-text + schema-drift(game_id/hashtags/snapshot/created_at) fields immutable; title/content editable';
END $$;

-- ---------- N3b pre-vote 글도 비텍스트 불변(삼순 지적: 첫 투표 전 개방 차단) ----------
-- 삼순 NO-GO(2): 기존 denylist 는 first_vote_at IS NOT NULL 일 때만 비교해 투표 전엔
-- 작성자가 직접 UPDATE 로 content_type/image_urls 를 바꿀 수 있었다. allowlist 는 투표 여부
-- 무관하게 title/content 외 불변이므로 pre-vote 에서도 비텍스트 변경은 거부되어야 한다.
DO $$
DECLARE v_pid bigint;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','pre-vote lock?',null,false,
    now()+interval '1 day','[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb);
  -- 투표 전이라도 title/content 는 수정 가능.
  UPDATE posts SET title='q-edit-prevote', content='c-edit-prevote' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'q-edit-prevote' THEN
    RAISE EXCEPTION 'FAIL N3b: pre-vote title edit did not persist'; END IF;
  -- 비텍스트는 투표 전에도 불변.
  BEGIN UPDATE posts SET content_type='photo' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3b: pre-vote content_type change accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET image_urls='["https://attacker.invalid/pv.jpg"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N3b: pre-vote image_urls change accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT content_type FROM posts WHERE id=v_pid) = 'photo' THEN
    RAISE EXCEPTION 'FAIL N3b: pre-vote non-text mutated'; END IF;
  RAISE NOTICE 'PASS N3b pre-vote poll: non-text fields immutable; title/content editable';
END $$;

-- ---------- N4 title/content 유효성 DB 강제(서버 route 우회 방어) ----------
DO $$
DECLARE v_pid bigint;
BEGIN
  v_pid := current_setting('poll.pid')::bigint;
  BEGIN UPDATE posts SET title='' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N4: empty title accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET title='   ' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N4: whitespace-only title accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET title=repeat('x',201) WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N4: title>200 accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET content=repeat('y',2001) WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N4: content>2000 accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  -- 경계값은 허용(<=200, <=2000).
  UPDATE posts SET title=repeat('x',200), content=repeat('y',2000) WHERE id=v_pid;
  IF char_length((SELECT title FROM posts WHERE id=v_pid)) <> 200 THEN
    RAISE EXCEPTION 'FAIL N4: 200-char title not persisted'; END IF;
  RAISE NOTICE 'PASS N4 poll title required + title<=200 + content<=2000 enforced in DB';
END $$;

-- ---------- N6 삼순 3차 NO-GO P1-1: 운영/모더레이션 필드 직접 위조 차단 ----------
-- 기존 allowlist 는 운영필드(report_count/is_hidden/조회·좋아요·댓글/updated_at)를 비교에서
-- 무조건 제외해 작성자가 직접 UPDATE 로 위조 가능했다(독립 PG17 UPDATE 1). 이제 GUC 미설정
-- (작성자 직접 경로)에서는 title/content/updated_at 외 전부 불변 → 전부 check_violation.
DO $$
DECLARE v_pid bigint; v_rc int; v_hidden boolean; v_old_ua timestamptz;
BEGIN
  v_pid := current_setting('poll.pid')::bigint; -- voted poll
  SELECT report_count, is_hidden INTO v_rc, v_hidden FROM posts WHERE id=v_pid;

  BEGIN UPDATE posts SET report_count = report_count + 999 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: report_count forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET is_hidden = true WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: is_hidden forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET like_count = 999 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: like_count forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET comment_count = 999 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: comment_count forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET click_view_count = 999, impression_view_count = 999 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: view_count forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  -- 결합 위조(title 편집에 운영필드 끼워넣기)도 거부.
  BEGIN UPDATE posts SET title='ok-q', report_count=report_count+5 WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N6: title+report_count combined forge accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;

  -- updated_at 은 DB 서버생성 시각으로 강제 — 클라 제공값 위조 불가(삼순 4/5차 NO-GO).
  --   삼순 5차: OLD 를 *과거값*으로 먼저 고정해, now()→OLD.updated_at fault-injection 이면 반드시
  --   실패하도록 assert 를 강화한다. 즉 편집 후 updated_at 은 (트랜잭션 now() 근사) AND (!= OLD)
  --   둘 다 만족해야 한다. OLD 가 트랜잭션 now() 와 달라야 두 assert 가 직교함(구분력 확보).
  -- 먼저 OLD 를 과거값으로 심는다(운영 writer 스코프 GUC 사용 → 잠금 우회해 과거 updated_at 기록 가능).
  PERFORM set_config('kbo.posts_op', '1', true);
  UPDATE posts SET updated_at = timestamptz '2000-01-01 00:00:00+00' WHERE id=v_pid;
  PERFORM set_config('kbo.posts_op', '', true);
  SELECT updated_at INTO v_old_ua FROM posts WHERE id=v_pid; -- v_old_ua = 2000-01-01(과거)

  -- (a) 순수 updated_at 변경(질문/설명 미변) → 위조값 미반영(OLD 과거값 그대로 유지).
  UPDATE posts SET updated_at = timestamptz '1999-06-06 00:00:00+00' WHERE id=v_pid;
  IF (SELECT updated_at FROM posts WHERE id=v_pid) IS DISTINCT FROM v_old_ua THEN
    RAISE EXCEPTION 'FAIL N6: bare updated_at forge persisted (expected OLD 2000-01-01 retained)'; END IF;

  -- (b) title 편집 + updated_at 위조 → title persist, updated_at 은 트랜잭션 now() AND != OLD(과거).
  --     now()→OLD.updated_at 구현이면 v_old_ua(2000-01-01) 가 남아 두 assert 모두 실패.
  UPDATE posts SET title='q-ua-edit', updated_at = timestamptz '1999-06-06 00:00:00+00' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'q-ua-edit' THEN
    RAISE EXCEPTION 'FAIL N6: title edit did not persist'; END IF;
  IF (SELECT updated_at FROM posts WHERE id=v_pid) IS DISTINCT FROM transaction_timestamp() THEN
    RAISE EXCEPTION 'FAIL N6: updated_at not forced to transaction now() on title edit (got %)',
      (SELECT updated_at FROM posts WHERE id=v_pid); END IF;
  IF (SELECT updated_at FROM posts WHERE id=v_pid) = v_old_ua THEN
    RAISE EXCEPTION 'FAIL N6: updated_at == OLD after title edit (now()->OLD fault not caught)'; END IF;

  IF (SELECT report_count FROM posts WHERE id=v_pid) <> v_rc
     OR (SELECT is_hidden FROM posts WHERE id=v_pid) <> v_hidden
     OR (SELECT like_count FROM posts WHERE id=v_pid) <> 0
     OR (SELECT comment_count FROM posts WHERE id=v_pid) <> 0
     OR (SELECT click_view_count FROM posts WHERE id=v_pid) <> 0 THEN
    RAISE EXCEPTION 'FAIL N6: operational field mutated despite reject'; END IF;

  -- 정당한 편집(질문·설명)은 통과.
  UPDATE posts SET title='q-legit-edit', content='c-legit-edit' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'q-legit-edit' THEN
    RAISE EXCEPTION 'FAIL N6: legit title/content edit did not persist'; END IF;
  RAISE NOTICE 'PASS N6 operational/moderation fields (report/is_hidden/counters) not forgeable; updated_at DB-authoritative (client value ignored); legit title/content edit persists';
END $$;

-- ---------- N6b 정당한 운영 경로(신고→auto_blind, SECURITY DEFINER + ALTER SET GUC)는 유지 ----------
-- auto_blind_on_report 가 poll 글의 report_count 를 갱신할 때 strict 잠금에 막히지 않아야 한다.
DO $$
DECLARE v_pid bigint; v_before int; v_after int;
BEGIN
  v_pid := current_setting('poll.pid')::bigint;
  SELECT report_count INTO v_before FROM posts WHERE id=v_pid;
  INSERT INTO reports(target_type, target_id, reporter_id)
    VALUES ('post', v_pid, '99999999-9999-9999-9999-999999999999');
  SELECT report_count INTO v_after FROM posts WHERE id=v_pid;
  IF v_after <> v_before + 1 THEN
    RAISE EXCEPTION 'FAIL N6b: legit report path blocked by lock (report_count % -> %)', v_before, v_after; END IF;
  RAISE NOTICE 'PASS N6b legit report->auto_blind path updates poll report_count (SECURITY DEFINER GUC bypass works)';
END $$;

-- ---------- ⑧ cascade 재집계 (계정/글 삭제) ----------
DO $$
DECLARE v_pid bigint; o1 bigint; o2 bigint; bv int; av int; ao2 int;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cascade?',null,false,now()+interval '1 day',
    '[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb);
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  SELECT id INTO o2 FROM poll_options WHERE post_id=v_pid ORDER BY position DESC LIMIT 1;
  PERFORM cast_poll_vote(v_pid,'11111111-1111-1111-1111-111111111111',ARRAY[o1]);
  PERFORM cast_poll_vote(v_pid,'22222222-2222-2222-2222-222222222222',ARRAY[o2]);
  SELECT voter_count INTO bv FROM poll_polls WHERE post_id=v_pid;
  IF bv<>2 THEN RAISE EXCEPTION 'FAIL ⑧ setup: voters=%',bv; END IF;

  DELETE FROM auth.users WHERE id='22222222-2222-2222-2222-222222222222'; -- account delete → votes cascade
  SELECT voter_count INTO av FROM poll_polls WHERE post_id=v_pid;
  SELECT vote_count INTO ao2 FROM poll_options WHERE id=o2;
  IF av<>1 OR ao2<>0 THEN RAISE EXCEPTION 'FAIL ⑧: voters=% o2=%',av,ao2; END IF;
  RAISE NOTICE 'PASS ⑧ account delete cascade → trigger recalc (voter=1, orphan option=0)';

  DELETE FROM posts WHERE id=v_pid;
  IF EXISTS(SELECT 1 FROM poll_polls WHERE post_id=v_pid)
     OR EXISTS(SELECT 1 FROM poll_options WHERE post_id=v_pid)
     OR EXISTS(SELECT 1 FROM poll_votes WHERE post_id=v_pid) THEN
    RAISE EXCEPTION 'FAIL ⑧: post delete did not cascade'; END IF;
  RAISE NOTICE 'PASS ⑧ post delete cascades poll rows (locked poll deletable via cascade)';

  -- 남은 user2 fixture 복구(후속 블록 없음이지만 명시)
  INSERT INTO auth.users(id) VALUES ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
END $$;

-- ---------- ⑨-2 첫 투표 후 posts 2-step 우회(board_type 변경) 차단 (삼순 NO-GO 축1) ----------
-- 구 구현은 board_type<>'poll' 이면 잠금 분기를 통과시켜, 첫 투표 후
--   UPDATE posts SET board_type='free'  (분기 탈출) → UPDATE posts SET title=...
-- 2-step 으로 title/content 를 바꿀 수 있었다. 잠금을 poll_polls 존재 기준으로
-- 바꿔 board_type 변경 자체가 거부되므로 1단계부터 실패해야 한다.
DO $$
DECLARE v_pid bigint;
BEGIN
  v_pid := current_setting('poll.pid')::bigint; -- has votes (first_vote_at set)
  BEGIN UPDATE posts SET board_type='free' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨-2: board_type change accepted (2-step bypass open)';
    EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET board_id='free' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨-2: board_id change accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET team_tags='["hacked"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨-2: team_tags change accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET player_tags='["1:hacked"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨-2: player_tags change accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  -- 전체 2-step 을 단일 트랜잭션에서 시도해도 1단계(board_type)부터 실패함을 명시.
  BEGIN
    UPDATE posts SET board_type='free' WHERE id=v_pid;
    UPDATE posts SET title='hacked-2step' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨-2: 2-step board_type→title bypass accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT board_type FROM posts WHERE id=v_pid) <> 'poll'
     OR (SELECT title FROM posts WHERE id=v_pid) = 'hacked-2step' THEN
    RAISE EXCEPTION 'FAIL ⑨-2: post mutated after bypass attempt'; END IF;
  RAISE NOTICE 'PASS ⑨-2 2-step bypass blocked (board_type/board_id/title/tags immutable after first vote)';
END $$;

-- ---------- 축2 create_poll 이 canonical team_tags/player_tags 를 posts 에 원자 기입 ----------
-- 라우트가 파생·검증한 태그를 create_poll 이 posts 에 그대로 적재하는지(현 [] 밖에
-- 안 들어가던 결함). ref 삼각검증/파생 자체는 route-level E2E(poll-route-e2e.ts)가 고정.
DO $$
DECLARE v_pid bigint; v_tt jsonb; v_pt jsonb;
BEGIN
  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','team tags?',null,false,now()+interval '1 day',
    '[{"kind":"team","ref_id":"lg"},{"kind":"team","ref_id":"doosan"}]'::jsonb,
    '["lg","doosan"]'::jsonb, '[]'::jsonb);
  SELECT team_tags, player_tags INTO v_tt, v_pt FROM posts WHERE id=v_pid;
  IF v_tt <> '["lg","doosan"]'::jsonb OR v_pt <> '[]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 축2: team poll tags tt=% pt=%', v_tt, v_pt; END IF;

  v_pid := create_poll('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','player tags?',null,false,now()+interval '1 day',
    '[{"kind":"player","ref_id":"53006"},{"kind":"player","ref_id":"56769"}]'::jsonb,
    '["kt","hanwha"]'::jsonb, '["53006:강건","56769:강건우"]'::jsonb);
  SELECT team_tags, player_tags INTO v_tt, v_pt FROM posts WHERE id=v_pid;
  IF v_tt <> '["kt","hanwha"]'::jsonb OR v_pt <> '["53006:강건","56769:강건우"]'::jsonb THEN
    RAISE EXCEPTION 'FAIL 축2: player poll tags tt=% pt=%', v_tt, v_pt; END IF;
  RAISE NOTICE 'PASS 축2 create_poll writes canonical team_tags/player_tags into posts atomically';
END $$;

-- ---------- 운영경로 회귀 (삼순 P0 교차회귀): poll 글의 신고/카운터/투표전 편집 허용 ----------
-- 직전 회귀: poll_posts_edit_lock UPDATE 분기가 OLD∥NEW board_type='poll' 이면 GUC 없을 때
-- 모든 UPDATE 를 23514 로 거부 → 신고(report_count/is_hidden)·카운터(click/impression/like/comment)·
-- 투표 전 title/content 수정까지 전부 막힐. 가드를 board_type/board_id 변경에만 좁혀
-- 이들 정상 운영 UPDATE 가 통과하는지 실 PG17 로 고정한다(shim 에 운영 컬럼/트리거 반영함).
-- ⚠ create_poll 은 kbo.poll_write 를 transaction-local 로 세우므로, 아래 phantom/타입변경
--   거부 assert 가 유효하려면 poll 생성과 assert 가 같은 트랜잭션에 있으면 안 된다.
--   따라서 pre-vote poll 은 top-level 문장(autocommit)으로 만들어 pid 를 GUC 에 보관하고,
--   아래 DO 블록 안에서는 create_poll 을 호출하지 않는다(깨끗한 GUC 상태).
SELECT create_poll(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','pre-vote editable?',null,false,
  now()+interval '1 day','[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb
) AS oppath_pid \gset
SELECT set_config('poll.oppath_pid', :'oppath_pid', false);
DO $$
DECLARE v_pid bigint; v_new_pid bigint := current_setting('poll.oppath_pid')::bigint; v_free bigint;
        v_rc int; v_hidden boolean; v_cvc int; v_ivc int; v_lc int; v_cc int;
BEGIN
  -- (1) 투표 전(first_vote_at NULL) poll 글: title/content 수정 성공해야 함
  UPDATE posts SET title='edited-before-vote' WHERE id=v_new_pid;
  UPDATE posts SET content='edited-content-before-vote' WHERE id=v_new_pid;
  IF (SELECT title FROM posts WHERE id=v_new_pid) <> 'edited-before-vote' THEN
    RAISE EXCEPTION 'FAIL 운영: pre-vote title edit did not persist'; END IF;

  -- (2) 신고 경로: reports 3회 INSERT → auto_blind 트리거가 posts 를 UPDATE → report_count=3, is_hidden=true
  INSERT INTO reports(target_type,target_id,reporter_id) VALUES
    ('post',v_new_pid,'11111111-1111-1111-1111-111111111111'),
    ('post',v_new_pid,'22222222-2222-2222-2222-222222222222'),
    ('post',v_new_pid,'33333333-3333-3333-3333-333333333333');
  SELECT report_count, is_hidden INTO v_rc, v_hidden FROM posts WHERE id=v_new_pid;
  IF v_rc <> 3 OR v_hidden IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL 운영: poll report path blocked (report_count=% is_hidden=%)', v_rc, v_hidden; END IF;

  -- (3) 조회/좋아요/댓글 카운터 — 실제로는 SECURITY DEFINER writer(update_like_count/
  --     update_comment_count/increment_post_view, ALTER FUNCTION SET kbo.posts_op='1')가
  --     갱신하므로 그 실행 스코프를 재현한다(GUC='1' 시 strict 잠금 우회 → 카운터 갱신 허용).
  PERFORM set_config('kbo.posts_op', '1', true);
  UPDATE posts SET click_view_count = click_view_count + 1 WHERE id=v_new_pid;
  UPDATE posts SET impression_view_count = impression_view_count + 1 WHERE id=v_new_pid;
  UPDATE posts SET like_count = like_count + 1 WHERE id=v_new_pid;
  UPDATE posts SET comment_count = comment_count + 1 WHERE id=v_new_pid;
  PERFORM set_config('kbo.posts_op', '', true); -- 스코프 종료 → 이후 잠금 다시 활성
  SELECT click_view_count, impression_view_count, like_count, comment_count
    INTO v_cvc, v_ivc, v_lc, v_cc FROM posts WHERE id=v_new_pid;
  IF v_cvc<>1 OR v_ivc<>1 OR v_lc<>1 OR v_cc<>1 THEN
    RAISE EXCEPTION 'FAIL 운영: poll counter update blocked (cvc=% ivc=% lc=% cc=%)', v_cvc,v_ivc,v_lc,v_cc; END IF;

  -- (4) 첫 투표 후엔 title/content 구조 수정 여전히 거부(잠금 계약 유지)
  v_pid := current_setting('poll.pid')::bigint; -- has votes
  -- 2026-07-28 완화: 첫 투표 후에도 title/content 수정 허용(선지·마감은 별도 트리거 잠금).
  UPDATE posts SET title='post-vote-edited', content='post-vote-desc' WHERE id=v_pid;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'post-vote-edited'
     OR (SELECT content FROM posts WHERE id=v_pid) <> 'post-vote-desc' THEN
    RAISE EXCEPTION 'FAIL 운영: post-vote title/content edit did not persist'; END IF;
  -- 투표 후에도 운영 카운터/신고는 허용(SECURITY DEFINER writer 스코프 GUC 재현 / 신고는 auto_blind)
  PERFORM set_config('kbo.posts_op', '1', true);
  UPDATE posts SET like_count = like_count + 1 WHERE id=v_pid;
  PERFORM set_config('kbo.posts_op', '', true);
  INSERT INTO reports(target_type,target_id,reporter_id)
    VALUES ('post',v_pid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  IF (SELECT report_count FROM posts WHERE id=v_pid) < 1 THEN
    RAISE EXCEPTION 'FAIL 운영: post-vote report_count not incremented'; END IF;

  -- (5) 운영 컬럼 존재 상태에서도 phantom/타입변경은 계속 거부되어야 함
  BEGIN
    INSERT INTO posts(author_id,board_type,board_id,title,content)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','poll','poll','phantom2','');
    RAISE EXCEPTION 'FAIL 운영: phantom poll INSERT accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO posts(author_id,board_type,board_id,title,content)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','team','lg','ordinary2','')
    RETURNING id INTO v_free;
  BEGIN UPDATE posts SET board_type='poll', board_id='poll' WHERE id=v_free;
    RAISE EXCEPTION 'FAIL 운영: non-poll→poll accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET board_type='free' WHERE id=v_new_pid;
    RAISE EXCEPTION 'FAIL 운영: poll→free accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET board_id='free' WHERE id=v_new_pid;
    RAISE EXCEPTION 'FAIL 운영: poll board_id change accepted'; EXCEPTION WHEN check_violation THEN NULL; END;

  RAISE NOTICE 'PASS 운영경로: pre/post-vote title/content edit + report(report_count=3,is_hidden) + view/like/comment counters allowed; phantom/non-poll→poll/poll→free/board_id still rejected';
END $$;

-- ---------- N5 2계정 RLS 실행형 회귀(삼순 NO-GO(3): 작성자 성공·타인 불변) ----------
-- 삼순가 지적한 "2계정 기준" 실행형: 작성자(author)는 title/content 저장 성공,
-- 타인(other)은 posts owner UPDATE RLS 로 0 rows(응답 무변). auth.uid()=request.jwt.claim.sub GUC.
-- create_poll 자체는 service-role(SECURITY DEFINER) 이므로 authenticated 로 바꾸기 전 생성.
SELECT create_poll(
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','rls 2-account?',null,false,
  now()+interval '1 day','[{"kind":"etc","label":"a"},{"kind":"etc","label":"b"}]'::jsonb
) AS rls_pid \gset
SELECT set_config('poll.rls_pid', :'rls_pid', false);

-- (1) 타인(other=2222...) — RLS 로 UPDATE 0 rows, 데이터 불변.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '22222222-2222-2222-2222-222222222222', false);
DO $$
DECLARE v_pid bigint := current_setting('poll.rls_pid')::bigint; v_n int;
BEGIN
  WITH u AS (UPDATE posts SET title='other-hacked', content='other-hacked' WHERE id=v_pid RETURNING 1)
  SELECT count(*) INTO v_n FROM u;
  IF v_n <> 0 THEN RAISE EXCEPTION 'FAIL N5: other-user UPDATE affected % rows (RLS should block)', v_n; END IF;
END $$;
RESET ROLE;
-- 타인 UPDATE 가 실제로 반영 안 됐는지 service-role 로 확인.
DO $$
DECLARE v_pid bigint := current_setting('poll.rls_pid')::bigint;
BEGIN
  IF (SELECT title FROM posts WHERE id=v_pid) = 'other-hacked' THEN
    RAISE EXCEPTION 'FAIL N5: other-user mutated poll title despite RLS'; END IF;
END $$;

-- (2) 작성자(author=aaaa...) — title/content 저장 성공.
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false);
DO $$
DECLARE v_pid bigint := current_setting('poll.rls_pid')::bigint; v_n int;
BEGIN
  WITH u AS (UPDATE posts SET title='author-edited', content='author-desc' WHERE id=v_pid RETURNING 1)
  SELECT count(*) INTO v_n FROM u;
  IF v_n <> 1 THEN RAISE EXCEPTION 'FAIL N5: author UPDATE affected % rows (expected 1)', v_n; END IF;
  IF (SELECT title FROM posts WHERE id=v_pid) <> 'author-edited' THEN
    RAISE EXCEPTION 'FAIL N5: author title edit did not persist'; END IF;
  -- 작성자라도 비텍스트 필드는 allowlist 트리거로 차단(RLS 통과해도 트리거가 막음).
  BEGIN UPDATE posts SET image_urls='["https://attacker.invalid/rls.jpg"]'::jsonb WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL N5: author non-text field change accepted';
    EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
RESET ROLE;
DO $$ BEGIN RAISE NOTICE 'PASS N5 2-account RLS: other-user UPDATE 0 rows (blocked); author title/content persists; author non-text still trigger-blocked'; END $$;

SELECT 'DB E2E COMPLETE (①②④⑤⑦⑧⑨ + direct poll-post write + duplicate ref RPC + tags/validations + 운영경로(신고/카운터/투표전편집) 회귀; ③⑩ hidden/snapshot route checks in poll-route-e2e.ts + ⑥ concurrency in .sh)' AS status;
