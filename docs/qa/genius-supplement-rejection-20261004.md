# 플라이아웃 보충 적재 실험 종료 — 2026-10-04

상태: **ⓓ 기각 / 적재 금지 / 보충 적재 복구 트랙 종료**. 코드·DB·프로덕션 변경 없음.

## 판정과 정정

삼순 작성자 실험 88/88회 및 삼식의 원장 6개·산출물 독립 대조에 근거한다. 단독 엄격 정답은 2/10이지만 두 건(rep3·9) 모두 GENERAL 다운그레이드다. **rag 경로 엄격 정답 0/8이며 복구 효과 없음**. llm 이탈을 보충 적재 개선으로 계산하지 않는다. DB 쓰기는 0이다.

- 단독: rag 8·llm 2. 명시 오답 rep1·2·8, 정의 미답 rep0·4·5·6·7.
- 실제 모델 근거 10/10 동일: p62(174)·FLY51·p65·정의40(777)·정의40(473)·p150(800). FLY51은 2위지만 p150은 6위에 남고 p66은 검색 후보 7위로 생성 근거 밖이다. 후보 12개와 실제 생성 근거 6개를 구분한다.
- 턴1 포구 정의: rag 10/10·정의 정답 10/10, CATCH679 1위·CATCH417 2위.
- 원본 18×3: rag 48·unsure 3·dictionary 3. base 대비 후보 변동 10/18·모델 근거 변동 9/18, 보충 27칸/9문항. 정의40·p66 탈락 0. 2아웃 만루는 3/3 보류 유지.
- 타격방해 10회: rag 10/10·검색 미진입 0. setC의 검색 미진입은 보충과 무관한 라우팅 편차로 정정한다.
- 아까 그 선수 3회: rag 2·llm 1, 명시 되묻기 1/3. 해결 아님.
- ctxA 기록용 1회: 기존 부기 오독 재현. 문맥 경로는 개선 없음(arm1·arm3 각각 8/10 오답 유지); 표본 차이를 유의한 악화로 단정하지 않는다.

## 산출물 보존 및 적재 금지

`req-rulebook-D.jsonl`: 기존 정의40 2청크 + CATCH679·CATCH417·FLY51 = 5행, 2,397자.

- outputSha256: `e320f12852703b967ffe898e2d7ee55502605221e0007253563669cb052e9a39`
- sourcePdfSha256: `deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a`
- dry-run revision: `sha256:4eefe4c5b3b2b`
- 최초 상대경로 dry-run은 invalid_required_supplement로 실패, 절대경로 재실행은 통과. dry-run 통과는 적재 승인이 아니다.
- 기존 9청크 `req-rulebook-r1.jsonl`과 새 5청크 모두 적재 후보에서 폐기하되 증거는 보존한다.

원장: `/Volumes/T7-Dev/reviews/runtime/artlead-r0/`의 `sup-soloD.json`, `sup-turn1D.json`, `sup-orig-D.json`, `sup-interferenceD.json`, `sup-deicticD.json`, `sup-ctxD.json`, `D-summary.json`, `D-assessment.json`, `D-artifact-sha256.json`. 원장 당시의 reviewer pending 표기는 역사 기록이며, 이후 삼식 대조에서 수치 일치·기각 동의가 확인됐다.

## 후속 범위 분리

ⓐ(setC)·ⓒ(1단위 병합)·ⓓ(CATCH+FLY51)는 모두 기각. FLY51의 독립 인과효과를 확정하지 않는다. 남은 문제는 p62 [부기]의 제외 범위를 생성 답변이 뒤집는 현상이다.

- 플라이아웃 생성 측 설계는 별도 다음 PR. 단독·문맥 arm 및 정당아웃 포함 원본 18×3 회귀 필수. 프롬프트 지침 덧대기·수기답·질문 regex 라우팅·상한 우회·답변 재작성 제외.
- ⓔ 173자 절단 수정은 v3.1 코퍼스 위생/재적재 트랙으로 분리. 이 문서는 재적재 승인이 아니다.
- 앱 구조데이터 일정·선발·순위 결속은 [#1503](https://github.com/hwinside/kbo-everyday/pull/1503) 머지됨. 타순·진출 확정 잔여 범위와 생성 측 구현은 이 문서 PR에 포함하지 않는다.

Related wiki: [야잘알봇 Notion](https://www.notion.so/3aec901bb37281408cecf4c700b96487), 로컬 미러 `wiki/pages/크보팬/야잘알봇.md`.
