# #1534 후속: scripts-only 원문 span 후보 R0

기준: #1534 승인 head `82324652d28d8bdca355f0999fabc8f1d8cbfd84`, squash `6d90de9cf251dd7c50ca553dce867e53788a31a8`.
설계 SSOT: https://www.notion.so/3aec901bb37281408cecf4c700b96487#3efc901bb37281ebbc19da7b135b6363

## 범위와 상태

- src·DB·ingestion·설정·시스템 지침 변경 0. scripts-only 실험이며 제품 연결 아님.
- 구현 후보와 오프라인 smoke를 작성했다. 작성자는 타입 검사만 수행한다. QA 스크립트 실행·판정은 삼식 담당이고 새 모델 재생은 구현 리뷰 뒤다.
- 자동 census/효과 PASS를 주장하지 않는다. smoke의 census assertion은 실행 결과가 아니라 HOLD 게이트다.
- 순수 파서는 원문 전체의 SHA256/URL/revision/sectionPath와 UTF-16 half-open span을 결속한다. 렌더 때 재파싱·전체 계약 대조하며, 불일치면 원문 유지다.
- 문법 범위는 완결 한국어 서술문과 단일 선행 조건/현재 관형절로 좁혔다. 과거 서술·비용 공제·보조사·주제절의 의미를 추론하지 않는다. 파서 거절 이유는 과거 수동 의미 판독 사유와 같다는 주장이 아니다.
- 원문 18행 fixture는 읽기 전용 9,152행 스냅샷에서 복사한 테스트 데이터다. 배포 매니페스트/문항 분기/허용목록이 아니다. 각 원문 hash 및 수동 PASS/reject와 자동 결과를 행별 비교한다.
- 기존 rawEvidence/guardEvidence/modelEvidence 입력 객체는 변경하지 않는다. 원본 raw source에서 먼저 span을 산출하고, 완성 payload의 정확한 공식 자료 블록에서만 해당 원문 표시를 치환한다. 이는 제품 bundle 조립 훅 대신 사용하는 scripts-only 어댑터다.
- 형제 anchor는 기존 고정 본문 라벨 뒤의 원문 suffix가 완전히 맞을 때만 치환한다. **중첩 형제 JSON 원문은 이번 R0에서 변환하지 않는다.** 그 안에만 후보가 있으면 미적용이며 노출 실패 HOLD다. 형제/열거·괄호 주석은 byte-identical로 남긴다. 합성 문자열 재파싱 없음.
- 최대 6 primary/7 physical/형제 1개, +19 units/문장, +133 units/요청. 현재 R0는 primary에만 적용하므로 실제 상한은 +114 units다. 초과는 원문 유지한다.
- 전송은 기존 `server.callOfficialRagLlm`을 호출한다. 순차 진단 동안 fetch의 정확한 요청 body만 바꾸고 URL/auth/header/signal/timeout/응답·오류 처리는 기존 서버에 맡긴다. 중복/불일치 요청은 중단, finally에서 원상복구한다. 동시 실행 금지. 별도 모델 클라이언트·추가 모델 호출 0.

## 비차단 nit 반영

1. **긍정 조항이 modelEvidence에 노출된 arm이 생기는 시점에 문항 10개를 먼저 고정한 뒤 재생**한다. 현 플라이아웃 arm 직접 정답 게이트 N/A. 사후 성공 표본 선택 금지.
2. census는 **서로 다른 서빙 코퍼스 원문 12개(공식야구규칙 5개 포함)**다. 규칙 조항 12개나 자동 통과 12개가 아니다. 정확 표지 14/미지원 4, 수동 통과 6(서로 다른 5)/reject 8이다.
3. #1534 위키: Notion R1 31블록 재조회 + 머지/정정 노트 readback, wiki-audit PASS(시크릿0, 기존 stale5), 로컬 미러 `90f972d19b0e859a76f2fbe28da12527eda36755`.

## 독립 오프라인 검증 (네트워크·모델 호출 없음)

```sh
npx tsx scripts/qa/official-scope-spans-smoke.ts
```

검증: 실제 census·각 원문 SHA, 무손실 복원, identity/offset 변조, UTF-16 surrogate, 중첩/절단/다중 범위, raw/guard 보존, 기존 #1520 괄호 주석·문맥 지침·metadata/clock 보존, 실제 sibling builder anchor 경계, 미적용 payload byte-identical, mock fetch 1회/URL·header·signal 보존/실패 복구.

## 모델 재생 옵션 (리뷰 뒤에만)

기존 하네스에 `--scope-spans=base|candidate`, `--scope-snapshot-file=<absolute json>`을 함께 지정한다. 다른 실험 옵션과 혼용 금지. scope off는 기존 경로다. snapshot 없이 live 검색으로 양 arm을 비교하는 실행은 거절한다.

스냅샷 형식: `{ "version": 1, "referenceTimeMs": <고정 ms>, "queries": { "정확한 검색 질의": [<변경 없는 RagEvidence RPC rows>] } }`.
리뷰 담당자가 동일 읽기 전용 검색 결과를 고정하고 양 arm에 같은 파일을 사용한다. 파일 SHA와 reference clock은 결과 원장에 기록한다. 질의가 없으면 live fallback 없이 HOLD. 서로 다른 snapshot SHA 결과는 쌍 비교로 채택하지 않는다.
문맥은 승인된 `ctx-turn1-bound.json` 파일 SHA를 강제하며 직전 답변 재생성 없음.

`--suite=fair-catch --reps=3`은 고정 정규 포구 1×3을 추가한다. original 18문항은 그대로 두고 scope 모드 original reps=3, 단독/문맥 각10을 고정했다. 1차77/arm, 최종242/arm이며 추가 호출 예산을 늘리지 않는다.
교차 실행·동일 모델 설정·extras/선택 서명 대조와 의미 판독은 리뷰 후 재생 실행 원장에 결속해야 한다. 이 PR에서 교차 실행이나 484회 결과를 만들었다고 주장하지 않는다.

명시 역전0/10, 기존 정답→오답0, 추가 호출0 및 baseline 오독/후보 노출 게이트 유지. 오답 전환 목적지(정의 미답/INSUFFICIENT→보류/GENERAL)를 분리한다. GENERAL 정답을 rag 복구에 산입하지 않는다. 실패·미노출·census 불일치는 HOLD, 성공할 때까지 반복 재생하지 않는다.
