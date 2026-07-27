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

  RAISE NOTICE 'PASS create_poll validations (coexist/mix/count/closes/etc/ref_id)';
END $$;

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
  v_pid := current_setting('poll.pid')::bigint; -- has votes
  BEGIN UPDATE posts SET title='hacked' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨: posts title update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE posts SET content='hacked' WHERE id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨: posts content update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN INSERT INTO poll_options(post_id,position,kind,label_snapshot) VALUES (v_pid,9,'etc','sneak');
    RAISE EXCEPTION 'FAIL ⑨: option insert accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  SELECT id INTO o1 FROM poll_options WHERE post_id=v_pid ORDER BY position LIMIT 1;
  BEGIN UPDATE poll_options SET label_snapshot='x' WHERE id=o1;
    RAISE EXCEPTION 'FAIL ⑨: option structure update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN DELETE FROM poll_options WHERE id=o1;
    RAISE EXCEPTION 'FAIL ⑨: option delete accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN UPDATE poll_polls SET allow_multiple=true WHERE post_id=v_pid;
    RAISE EXCEPTION 'FAIL ⑨: allow_multiple update accepted'; EXCEPTION WHEN check_violation THEN NULL; END;
  UPDATE posts SET updated_at=now() WHERE id=v_pid; -- non-structural → allowed
  RAISE NOTICE 'PASS ⑨ edit-lock: title/content, option add/remove/struct, poll settings blocked; non-structural allowed';
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

SELECT 'DB E2E COMPLETE (①②④⑤⑦⑧⑨ + ⑨-2 2-step bypass + 축1축2 tags/validations; ③⑩ in poll-route-e2e.ts + ⑥ concurrency in .sh)' AS status;
