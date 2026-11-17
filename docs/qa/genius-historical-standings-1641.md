# #1641 과거 순위 제공 후속 R3 (재작업 2회)

## 변경과 제한
- base: b384980f6404b2aff8bb4d458d50cd01e4d3d29d (origin/main, #1643 이후).
- `appRequest.period=season` + 원문 결속 시즌·대회·전체/특정시점 계약. 정규식/표현 목록 분기 추가 없음.
- 유효한 과거 정규시즌 요청만 지연 조회. 네이버 스포츠 시즌 URL + REGULAR_SEASON 요청으로 구조화 자료 조회. 현시즌 HTML fallback 없음.
- 2015년 이후 10구단×144경기 완료 자료만 수용. 구단 중복, 전적 합계, 시즌/대회 메타 모순 거부. 원본 구단 표시명 보존.
- R1의 `ranking` 신뢰는 P0 오류였다. REGULAR_SEASON 요청도 일부 시즌의 ranking은 포스트시즌 순서다. R2는 W/(W+L) 정수 교차곱 순서와 1~10위를 전부 대조한다. 불일치·동률은 전체 표 HOLD; 재정렬만 해 정답이라고 단정하지 않는다.
- 상대 시즌 표현은 연도를 되묻는다(11월에 직전 시즌을 무조건 전년으로 계산하지 않음). 사용자 답변에는 출처·시즌 텍스트만 표시하고 raw JSON URL은 내부 provenance로 보존한다.
- 명시 연도의 KBO 시즌 전체/최종 순위는 정규시즌으로 답할 수 있으며 답변에 정규시즌·포스트시즌 미포함 범위를 명시한다. 리그/대회 범위가 불명확한 unspecified는 명확화. 시범/포스트/시즌 중 시점은 대체 금지. 타 시즌·부분 표·조회 장애는 HOLD. KBO 공식 자료라고 라벨링하지 않음.
- 로컬 502/timeout은 egress 경로 문제였으며 업스트림 장애 근거가 아니다. 삼식과 작성자 Aside 브라우저 경로에서 API 200 확인. **제품 경로의 실제 제공 복구는 독립 실모델 검증 전**. synthetic fixture는 실제 2025 순위를 뜻하지 않음.
- 기존 #1643 문구 수정·fixture 근거와 별개. #1641 종결 아님. #1645·#1646 미포함.

## 작성자 확인
- `npx tsc --noEmit --pretty false` exit 0.
- R3 변경 파일 eslint 오류 0 (crawler 기존 unused 경고 1).
- QA 실행 0; 아래 검증은 독립 리뷰어 실행 대상.
- graphify 갱신 명령 실행: `ModuleNotFoundError: No module named 'graphify'`. 기존 산출물 미변경.

## 독립 검증 요청
원문 fixture: `scripts/qa/fixtures/genius-historical-standings-naver-20261117.json`. Aside에서 각 시즌 API URL을 열어 표시된 JSON을 그대로 수집(2015/2019/2021/2022/2025, 각 10행). 값·순서를 고치지 않고 JSON 포맷만 정리했다. SHA-256 `4c798788bcf6ca2a0c68a1fc246f308a22ac7cee7049f0ab784f589dc3f74137`. 이는 수집 증거이며 수정 파서 QA PASS 선언이 아니다.

1. `npm run qa:genius-game-conversation`: 새 historical 검증을 통합했다. main에 신규 assertion만 올리면 성공 경로가 RED여야 한다.
2. 새 실제 2015/2019/2021/2022 응답 fixture에서 기존 R1 parser가 RED인지 확인. R2는 HOLD, 실제 2025 대조는 수용해야 한다. 승률 대조 제거·동률 차단만 제거 mutation도 각각 RED로 확인. synthetic 동률은 순위만 1/2로 정렬해도 통과할 수 없게 설계했다. 기존 시즌/대회 거부 제거·loader 제거·현재 순위 fallback mutation도 유지.
3. `scripts/qa/genius-standings-evidence.ts --out=<절대경로>`: 기존 connected lane에 실제 과거 순위 loader를 연결. 9질문×3반복×2배선; 분류·요청·자료·최종 저장 결과 확인. 요청 시점은 실행일 KST 기준.
4. 원본 네이버 응답 성공 건을 확보하고 2025 정규 최종 순위를 독립 공식 자료와 대조. URL만 시즌이 맞거나 synthetic fixture가 PASS라는 이유로 실제 복구 GO 금지. API가 계속 실패하면 복구 효과 HOLD.
5. 명시/상대 연도, 특정 구단, 리그 전체, 대회 미지정, 시범/포스트, 시즌 중 날짜, 현재 순위·보크 회귀 확인. live 모델이 period=unsupported/other로 잘못 분류하면 수정 필요.
6. 머지·배포 후 전용계정 실제 UI→DM 결과와 출처/시즌/대회 일치, 반복 관측·cleanup 확인. 작성자 self-check나 API만으로 End-User PASS를 대신하지 않음.

## 롤백
이 후속 PR만 revert. DB/마이그레이션/워크플로 변경 없음.

## R3 리뷰 반영
- R2 NO-GO: env 없는 CI에서 crawler import가 Supabase 클라이언트를 초기화해 필수 게이트 실패. 팀 코드 매핑을 순수 constants/teams로 이동하고 crawler도 동일 원본을 사용한다. historical loader는 crawler를 import하지 않는다.
- P1 선택: bare KBO 시즌 전체 순위의 정규시즌 답변을 유지하고 분류 지침·문서·회귀 assertion을 일치시킨다. 표현 목록 런타임 분기 없음.
- 독립 재검증: Supabase env 없이 game-conversation/evidence-hold/evidence-fingerprint/current-season-metrics 4종, 새 SHA CI 전체, bare KBO 2문장 실모델 paired 및 시범/포스트/가을야구 경계. 작성자는 QA 실행하지 않는다.
- P2 특정 팀 과거 순위가 팀 기록 안내로 보류되는 공백은 미해결. 현재 순위의 승률/순위 불일치는 기존 경로 별건이며 이 PR 수정 범위가 아니다. 후속 #1648에 원문·코드 근거를 등록했다.
