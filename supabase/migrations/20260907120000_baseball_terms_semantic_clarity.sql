-- Targeted glossary correction; no row/alias/provenance changes.
-- Catcher interference: 2026 KBO 5.05(b)(3), PDF p54 / printed p30.
-- Sweep: remove the unsupported equivalence with reverse sweep; no new reverse-sweep definition.
DO $semantic_clarity$
DECLARE
  current_answer text;
BEGIN
  SELECT answer INTO current_answer FROM public.baseball_terms WHERE term = '스윕' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing glossary term: 스윕'; END IF;
  IF current_answer IS DISTINCT FROM $old$한 시리즈(주로 3연전)를 모두 이기는 것입니다.
반대로 모두 지면 스윕패, 역스윕을 당했다고 합니다.
포스트시즌에서 상대를 전승으로 이기는 것도 스윕입니다.$old$ AND current_answer IS DISTINCT FROM $new$한 시리즈의 모든 경기를 이기는 것입니다.
정규시즌의 3연전에서 모두 이기거나 포스트시즌 시리즈를 전승으로 마치는 경우가 스윕입니다.
반대로 모든 경기를 지는 것은 스윕패입니다.$new$ THEN
    RAISE EXCEPTION 'Unexpected glossary answer for 스윕; review concurrent changes before applying';
  END IF;
  UPDATE public.baseball_terms SET answer = $new$한 시리즈의 모든 경기를 이기는 것입니다.
정규시즌의 3연전에서 모두 이기거나 포스트시즌 시리즈를 전승으로 마치는 경우가 스윕입니다.
반대로 모든 경기를 지는 것은 스윕패입니다.$new$ WHERE term = '스윕' AND answer IS DISTINCT FROM $new$한 시리즈의 모든 경기를 이기는 것입니다.
정규시즌의 3연전에서 모두 이기거나 포스트시즌 시리즈를 전승으로 마치는 경우가 스윕입니다.
반대로 모든 경기를 지는 것은 스윕패입니다.$new$;
  SELECT answer INTO current_answer FROM public.baseball_terms WHERE term = '타격방해' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Missing glossary term: 타격방해'; END IF;
  IF current_answer IS DISTINCT FROM $old$포수의 미트가 스윙하는 배트에 닿는 등 타격을 방해하는 것입니다.
타자는 1루로 출루합니다.
포수에게는 실책이 기록됩니다.$old$ AND current_answer IS DISTINCT FROM $new$포수 등 수비수가 타자의 타격을 방해하는 것입니다. 원칙적으로 타자는 1루 진루권을 얻습니다.
방해에도 플레이가 계속되면 공격팀 감독은 플레이가 끝난 직후 벌칙 대신 실제 플레이 결과를 선택할 수 있습니다.
타자가 안타, 실책, 4사구 등으로 1루에 나가고 다른 모든 주자가 최소 한 베이스를 진루했다면 방해와 관계없이 플레이는 계속됩니다.$new$ THEN
    RAISE EXCEPTION 'Unexpected glossary answer for 타격방해; review concurrent changes before applying';
  END IF;
  UPDATE public.baseball_terms SET answer = $new$포수 등 수비수가 타자의 타격을 방해하는 것입니다. 원칙적으로 타자는 1루 진루권을 얻습니다.
방해에도 플레이가 계속되면 공격팀 감독은 플레이가 끝난 직후 벌칙 대신 실제 플레이 결과를 선택할 수 있습니다.
타자가 안타, 실책, 4사구 등으로 1루에 나가고 다른 모든 주자가 최소 한 베이스를 진루했다면 방해와 관계없이 플레이는 계속됩니다.$new$ WHERE term = '타격방해' AND answer IS DISTINCT FROM $new$포수 등 수비수가 타자의 타격을 방해하는 것입니다. 원칙적으로 타자는 1루 진루권을 얻습니다.
방해에도 플레이가 계속되면 공격팀 감독은 플레이가 끝난 직후 벌칙 대신 실제 플레이 결과를 선택할 수 있습니다.
타자가 안타, 실책, 4사구 등으로 1루에 나가고 다른 모든 주자가 최소 한 베이스를 진루했다면 방해와 관계없이 플레이는 계속됩니다.$new$;
END;
$semantic_clarity$;
