-- 서빙 근거 top1 거리 관측 1칸 (2026-08-27, 삼순 #1313 재GO 조건 ③).
--
-- 왜 필요한가:
--   같은 PR 이 `RAG_DOCUMENT_MAX_DISTANCE = 0.42` 로 "근거가 있는가" 를 가르기 시작한다.
--   그런데 임계를 **값으로 두면서 그 값이 실제로 무엇을 자르는지 관측하지 않으면**
--   재보정이 영원히 감이 된다. 0.42 는 같은 코퍼스 직접 질의 **표본 15건의 타당성
--   파일럿**이지 캘리브레이션이 아니다:
--       정본 존재  0.2689 ~ 0.3787  (포스아웃·이닝교대·인필드플라이·피치·세이브 조건)
--       야구 무관  0.4281 ~ 0.5139  (주식·날씨·점심·파이썬·아이폰)
--   확정하려면 프로덕션 분포가 필요하고, 그 분포를 만드는 유일한 입력이 이 칸이다.
--
-- 계약:
--   · **관측값이다.** 이 칸을 읽고 분기하는 서빙 로직을 만들지 않는다
--     (`rag_attempt_path` 4칸과 동일 계약).
--   · 성공·폐기 **모두** 채운다 — 폐기에만 채우면 분자만 있고 분모가 없다.
--   · `null` = 거리 미제공(레거시 RPC·이 migration 이전 배포) 또는 거리 개념이 없는 경로
--     (선수·구단·뉴스 tier2 는 앱이 코사인을 다시 계산하므로 이 칸을 싣지 않는다).
--
--     🔴 **null 과 0 을 섞지 않는다.** 0 은 "완전 일치" 라서 부재를 0 으로 적으면 분포가
--        왼쪽으로 오염되고 임계가 실제보다 느슨해 보인다 — 재보정이 정확히 반대로 간다.
--        그래서 CHECK 는 `>= 0` 만 걸고 기본값을 두지 않는다(부재는 null 로 남는다).
--
--   · 코사인 거리 정의역은 [0, 2] 다. 상한을 걸어 오적재(유사도를 거리 칸에 넣는 등)를
--     DB 에서 잡는다 — 게이트가 못 본 배선 실수는 여기서 23514 로 드러나야 한다.
--
-- additive nullable 컬럼만 추가한다. 기존 행·기존 쿼리·다른 CHECK 무변경. 멱등.
alter table genius_question_logs
  add column if not exists rag_evidence_top_distance double precision;

alter table genius_question_logs
  drop constraint if exists genius_question_logs_rag_evidence_top_distance_check;
alter table genius_question_logs
  add constraint genius_question_logs_rag_evidence_top_distance_check
  check (
    rag_evidence_top_distance is null
    or (rag_evidence_top_distance >= 0 and rag_evidence_top_distance <= 2)
  );

comment on column genius_question_logs.rag_evidence_top_distance is
  '서빙 근거 top1 코사인 거리(관측 전용). null=거리 미제공/해당없음 — 0과 구분한다.';
