# 야잘알봇 질문 → 답변: 단일 경로 수집기

`npm run qa:ui:yajal-collect`는 **판정기가 아니다**. exit 0 및
`collectionFinished: true`는 수집 종료만 뜻한다. PASS/FAIL/INVALID와 답변 정확성은
삼식의 독립 판정부가 결정한다. 제품 코드·기존 QA 게이트는 바꾸지 않는다.

## 실행 준비 / Doctor

- 잠금파일 기준 의존성과 Playwright Chromium이 설치된 격리 워크트리에서 실행.
- 삼식이 새 전용 `qa-*@keubo.fan` 계정과 nickname이 있는 profile을 준비한다.
  개인 계정 금지. 이전 질문이 있는 계정은 거절한다. 같은 계정을 동시에 사용하지 않는다.
- 비밀값은 승인된 환경 주입으로 전달한다. 인자·명령 이력·로그에 값을 넣지 않는다.
  필수 환경: `QA_EMAIL`, `QA_PASSWORD`, `QA_TEST_USER_ID`,
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
  service-role은 사용하지 않는다. 저장소 `_env.mjs`도 읽지 않는다.
- `QA_BASE_URL`: 명시적 대상 origin. 기본 프로덕션 주소 없음.
- `QA_EXPECTED_SHA`: 대상 **앱** exact SHA. 수집기 SHA와 구분.
- `QA_BUILD_RECEIPT`: 삼식이 독립 확인한 배포 근거 JSON 파일 경로.
  `{ "origin": "https://...", "sha": "40 hex", "observedAt": "ISO timestamp",
  "checkedBy": "reviewer", "evidence": "실제 배포 확인 산출물 경로/URL" }`.
  30분 이내만 허용. 이 파일은 선언을 결속할 뿐 배포를 자동 검증하지 않는다.
  실행 전후 reviewer가 배포 SHA와 URL이 유지됐음을 확인해야 한다.
  로그인 토큰 등이 든 원시 응답 대신 비밀값 없는 근거를 제공한다.
- `QA_OUT`: 존재하지 않는 출력 디렉터리(부모는 미리 준비). 덮어쓰기 금지.
- `QA_QUESTION`: 기본 `희생번트는 타수에 들어가?`.
- `QA_REPLY_TIMEOUT_MS`: 기본 120000, 1000~180000. 독립 판정부도 이 값을 확인한다.

Doctor는 배포 근거 결속·서버 인증 사용자 ID·profile 준비·이전 질문 부재·홈 응답·
실제 로그인 전용 진입 버튼을 확인한다. HTTP 200만으로 준비 완료라 하지 않는다.

## 행동 / 기능 지도

홈 → `genius-entry-button` 클릭 → `/messages/new-{botId}` →
`쪽지를 입력하세요...` 입력 → `쪽지 보내기` 1회 → 실제 `/messages/{conversationId}`.

대화/질문을 admin INSERT하거나 RPC 직접 호출하지 않는다. 실제 UI가 생성한 방만
동일 사용자 RLS 세션으로 조회한다. 전송 결과가 불확실해도 자동 재전송하지 않는다.
질문 ID와 봇 답변의 `payload.question_message_id`를 결속한다. 나중에 도착한 임의의
봇 메시지는 답변으로 대신하지 않는다. 새 계정·새 대화로 과거 답변 혼입을 줄인다.

**범위 제외**: 로그인 UI(비밀번호 인증 + 세션 주입을 setup으로 사용), 기존 대화 재진입,
타인 권한, 다른 진입점, 답변 정확성 전반. 한 경로 결과를 전체 QA PASS로 확대하지 않는다.

## 증거 / 독립 판정

`evidence.json`과 SHA-256, 홈·입력창·결과 화면, 배포 근거 사본을 보존한다.
원시 쿠키·비밀번호·토큰·네트워크 본문·콘솔 메시지는 저장하지 않는다.
증거에는 다음을 구분한다.

- 앱 expected SHA / collector SHA / 외부 배포 근거(수집기 미검증 표시)
- 클릭 수행 횟수 / 관측 질문·답변 개수 / 오류 개수
- 실제 conversation ID, 질문·답변 행, 질문 FK, 화면 message ID·텍스트·렌더 관측
- 답변 deadline 도달, UI 렌더 지연, 단계별 수집 오류

판정부는 `collectionFinished`를 신뢰해 합격시키지 말고 화면과 행의 결속을 직접 확인한다.
관측이 유효한데 질문에 대한 답이 기한 내 없으면 제품 실패 후보이며, 인증·환경·조회
오류 또는 수행 0건은 유효한 성공 근거가 아니다. 최종 3값 기준은 독립 판정부 소유다.
최초 도입/관측 변경 때 정상 경로와 알려진 불량 경로를 모두 대조해 민감도를 확인한다.
합성 단위 테스트는 실제 앱에서의 이 검증을 대신하지 않는다.

## 정리

자기가 띄운 browser와 이번 로그인 세션만 종료한다. 원래 계정·대화·메시지는
자동 삭제하지 않는다. 새 질문/답변과 conversation ID를 남겨 삼식이 독립 확인한 뒤
해당 전용 계정 소유자가 정리한다. 증거는 보존한다. 정리 실패도 오류에 포함한다.

## 작성자 self-check

`npm run qa:yajal-collector-contract`: 잘못된/오래된 배포·개인 계정 거절,
다른 질문 답변 배제, 기존 증거 디렉터리 보존. 이것은 독립 End-User QA가 아니다.
