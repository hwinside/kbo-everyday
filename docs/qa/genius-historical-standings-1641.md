# #1641 과거 순위 제공 후속 R1

## 변경과 제한
- base: b384980f6404b2aff8bb4d458d50cd01e4d3d29d (origin/main, #1643 이후).
- `appRequest.period=season` + 원문 결속 시즌·대회·전체/특정시점 계약. 정규식/표현 목록 분기 추가 없음.
- 유효한 과거 정규시즌 요청만 지연 조회. 네이버 스포츠 시즌 URL + REGULAR_SEASON 요청으로 구조화 자료 조회. 현시즌 HTML fallback 없음.
- 2015년 이후 10구단×144경기 완료 자료만 수용. 구단 중복, 전적 합계, 시즌/대회 메타 모순 거부. 원본 구단 표시명 보존.
- 대회 미지정은 명확화, 시범/포스트/시즌 중 시점은 대체 금지. 타 시즌·부분 표·조회 장애는 HOLD. KBO 공식 자료라고 라벨링하지 않음.
- 실제 API 원문은 작성자 환경에서 2026-11-17 502/timeout. **실제 제공 복구 미검증**. synthetic fixture는 실제 2025 순위를 뜻하지 않음.
- 기존 #1643 문구 수정·fixture 근거와 별개. #1641 종결 아님. #1645·#1646 미포함.

## 작성자 확인
- `npx tsc --noEmit --pretty false` exit 0.
- 변경 파일 eslint 오류 0 (pipeline 기존 unused 경고 5).
- QA 실행 0; 아래 검증은 독립 리뷰어 실행 대상.
- graphify 갱신 명령 실행: `ModuleNotFoundError: No module named 'graphify'`. 기존 산출물 미변경.

## 독립 검증 요청
1. `npm run qa:genius-game-conversation`: 새 historical 검증을 통합했다. main에 신규 assertion만 올리면 성공 경로가 RED여야 한다.
2. parser의 시즌/대회 거부 제거, season lazy loader 호출 제거, 기존 unsupported로 복원, 현재 순위 fallback 주입 mutation을 각각 RED로 확인.
3. `scripts/qa/genius-standings-evidence.ts --out=<절대경로>`: 기존 connected lane에 실제 과거 순위 loader를 연결. 9질문×3반복×2배선; 분류·요청·자료·최종 저장 결과 확인. 요청 시점은 실행일 KST 기준.
4. 원본 네이버 응답 성공 건을 확보하고 2025 정규 최종 순위를 독립 공식 자료와 대조. URL만 시즌이 맞거나 synthetic fixture가 PASS라는 이유로 실제 복구 GO 금지. API가 계속 실패하면 복구 효과 HOLD.
5. 명시/상대 연도, 특정 구단, 리그 전체, 대회 미지정, 시범/포스트, 시즌 중 날짜, 현재 순위·보크 회귀 확인. live 모델이 period=unsupported/other로 잘못 분류하면 수정 필요.
6. 머지·배포 후 전용계정 실제 UI→DM 결과와 출처/시즌/대회 일치, 반복 관측·cleanup 확인. 작성자 self-check나 API만으로 End-User PASS를 대신하지 않음.

## 롤백
이 후속 PR만 revert. DB/마이그레이션/워크플로 변경 없음.
