# 정의 40 제외 범위 전달 실험 (미배포)

## 근거·가설
- base: f54bff6b3cf67210f05a7eb4c5157215650edae3 (#1518).
- 독립 운영 QA: 10문항 중 설명 오독 3건, 그중 qid 2302338은 직선타구도 인필드플라이라는 잘못된 긍정. 원본 `/Volumes/T7-Dev/reviews/runtime/qa-1518-prod.out`.
- 공식 원문 JSONL의 정의 40 첫 청크는 777자이며 괄호 전체를 포함한다. PDF SHA256 deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a, 물리 p201–202; 이번 턴에는 PDF 재다운로드가 아니라 기존 원문 대조 기록과 체크인 청크를 확인했다.
- 모델이 `직선타구 또는 번트한 것이 떠올라 플라이 볼이 된 것은 제외`의 병렬 제외를 번트에만 결속하는 것이 가설. 검색 누락이라고 단정하지 않는다.

## 비교 후보
원문을 그대로 두고, 자료 내부 파생 주석으로 `제외 A=직선타구`, `제외 B=번트한 것이 떠올라 플라이 볼이 된 것`을 분리한다. 질문/답 키워드 분기, 결론 강제, 숫자 허용 확대, 추가 모델 호출은 없다. 이번 후보는 의미 표현 실험이지 일반화된 제품 수정이 아니다.

`--annotations`는 URL + 공백 정규화한 전체 본문 SHA256 + tier1/kbo_ebook 일치 시에만 모델 입력에 주석을 붙인다. 원문/DB/embedding/검색 순서/최종 숫자 가드 근거는 그대로다. 주석 노출 수 및 실제 요청 전문을 남기고 0회면 HOLD 오류다. source 변경 시 자동 재사용하지 않는다. 내용을 자르거나 원문으로 가장하지 않는다.

## 독립 재생 예산·판정
삼식 실행 전용. 같은 checkout/환경에서 두 모드 각각 `--suite=exclusions --reps=3`: 24문항×3=72, 합계 144회 고정. base는 annotations 없이, candidate는 `--annotations=<이 디렉터리>/infield-exclusion-annotations.json`. 각기 다른 절대 --out 경로를 사용한다. 기존 보호된 실행 환경으로 실행하며 자격증명을 복사하지 않는다. 성공까지 반복하지 않는다.

- 최종 오판정(직선타구/번트 적용 긍정) 수, 원응답 오판정 수, 설명의 제외 역전 수를 각각 집계.
- unsure/error/timeout은 정답이 아니다. 양성 플라이의 정답률 및 1·2루/만루 조건 정확도, 대조군 회귀, p50/p95 지연과 tokens도 비교.
- 원본 18문항 부분집합을 별도 집계해 이전 결과와 비교. 추가 6문항은 직선타구 조건 변화, 번트 제외, `번트 아닌 직선타구` 및 일반 플라이 반례다.
- 후보를 못 본 응답/검색 차이/모델 호출 실패는 따로 기록. 후보가 대상 청크를 받지 못했으면 개선 결론을 내리지 않는다.
- 잘못된 긍정 또는 설명 역전이 한 건이라도 남으면 이 후보만으로 해결됐다고 보지 않는다. 0건이어도 표본 내 관측일 뿐 안전 보장이 아니다.

## 다음 제품 설계 결정
효과가 확인될 때만 검증된 원문 revision에 결속된 구조화 제외 항목을 ingestion 산출물로 보존하는 일반 데이터 계약을 설계한다. 이번 수기 manifest를 제품 예외 목록으로 배포하지 않는다. 실패하면 원문 인용/결론의 의미 검증을 별도 설계하되 추가 호출 비용·보류 증가·다른 규칙 회귀를 먼저 측정한다. 프로드/DB 변경, 머지 요청은 아직 없다.

## 현재 검증
최초 7cd37e7c 삼식 독립 재생: 각 72회. canonicalUrl 인코딩 불일치로 최초 후보는 3회 후 중단; URL만 원 표기로 수정한 사본으로 새 고정 예산을 실행했다. 후보 노출 60/72, 제외 21건 결론 오판정 0→0, 설명 역전 1→0(후보 제외항목 누락 1건), unsure 3→3. 양성/대조군 회귀 없음. p50 2565→2494ms, 입력 토큰 +79/회. base 결론 실패 미재현이므로 효과 입증도 부정도 불가. 증거: `/Volumes/T7-Dev/reviews/runtime/art-excl/`. #1518 쉼표 개선과 P0 제외 오독 해결을 구분한다.

## 집중 재생 R1 — 고정 80회
매니페스트 URL은 DB 원 URL의 한글 표기로 수정했다. 지문·출처 일치 조건은 완화하지 않았다.
삼식 실행: 동일 checkout/환경에서 base와 candidate 각각 `--suite=exclusion-focus --reps=5` (8문항×5=40회, 총 80회). 후보만 기존 `--annotations`를 지정한다. 기존 결과와 다른 절대 `--out` 경로 사용. 5회 외 예산은 하니스가 거부하며, base 실패를 얻기 위한 추가 반복은 하지 않는다.

질문은 코드의 고정 8개로, qid 2302338 원문과 띄어쓰기·라인드라이브·직선으로 뜨면·번트 아님·평범한 포구 변형만 포함한다. 모두 직선타구 제외를 묻지만 '직선으로 뜨면'의 모호성은 별도 표기한다. 원문과 명확한 6개 변형, 모호 표현 1개를 구분해 문항별 원응답·최종답의 잘못된 긍정/제외 설명/누락/unsure/error/timeout 및 주석 노출을 기록한다. 보류를 정답으로 세지 않는다.

base에서 결론 오판정이 관측되지 않으면 이번에도 **효과 판정 불가/HOLD**다. 관측되더라도 작은 표본의 감소만 보고하며 제품 GO로 확대하지 않는다. 이번 집중 suite에는 양성/이웃 의도 대조군이 없으므로 기존 72회 결과를 참고할 뿐 제품 회귀 검증을 대체하지 않는다.

## 제품화 일반 계약 초안 — 미구현
- ingestion이 원문 revision·전체 content hash·원문 내 범위(offset 및 인용문)에 결속된 `exclusion` 관계를 산출한다. 대상 범주와 제외 항목 각각의 원문 범위, 병렬 범위, 파서 버전을 보존한다.
- 규칙 이름·질문 키워드별 수기 주석 테이블은 금지한다. 모든 문서에 같은 구조화 계약을 적용하며, 애매한 병렬/부정/중첩 괄호는 자동 확정하지 않고 미구조화 상태로 남긴다.
- 원문 인용 범위 및 해시 일치 검증과 의미 검토를 통과한 산출물만 파생 데이터로 표시한다. 원문은 유지하고 검색·embedding·숫자 근거와 혼합하지 않는다. revision 변경 시 산출물을 무효화한다.
- 검증 대상은 병렬 제외, 번트 절의 수식 범위, 중첩 괄호, 비제외 괄호, 이중 부정, 서로 다른 규칙의 양성/음성 사례다. 문자열 분리만으로 의미 보존을 보장하지 않는다.
- 이번 수기 실험은 표현 효과만 평가한다. ingestion 추출의 정확성·일반화·실제 연결부는 별도 구현 및 독립 QA 대상이며, 집중 재생이 좋아도 수기 manifest 배포나 DB 적용은 하지 않는다.

## R2 — 자동 ingestion 계약 (미배포)
ce4f5beb 삼식 집중 재생: 각 40회, 결론 오판정/설명 역전 6→0,
unsure/error 양쪽 0, 후보 노출 40/40. 수기 주석 표현의 표본 내 효과이며
아래 자동 산출물의 효과나 제품 GO를 대신하지 않는다.

- `official-parenthetical-structure.mjs`: 규칙명/질문 분기 없이 모든 chunk에
  같은 파서를 적용한다. 정확한 본문 SHA256, source revision, UTF-16 offset,
  원문 인용, 버전을 저장한다. 원문·embedding·검색·숫자 가드는 변경하지 않는다.
- terminal `제외` 괄호만 exclusion으로 표시한다. OR가 하나이고 첫 항목이
  단일 명사 토큰인 경우만 분리한다. 그 외 병렬은 원문 통째로 보존한다.
  조건/부정은 `qualifier-quote`로만 인용하며 의미를 확정하지 않는다.
  중첩은 미구조화, 닫히지 않은/여분 괄호 chunk는 전체 주석 생성을 보류한다.
- renderer는 같은 입력으로 계약을 재산출하여 해시/버전/범위/항목/수정을
  검증한다. JSONB 키 순서 변화는 허용한다. 원문 바로 앞 문맥은 범주를
  임의 요약하지 않고 인용한다. 이런 문법 조건만으로 의미 정확성을 보장하지 않는다.
- 실제 `load-official-corpus.mjs`가 최종 chunk별 metadata를 산출한다.
  파서 버전은 revision에 결속되므로 향후 명시적 apply 시 새 generation이다.
  기존 source를 refresh하지 않았다. DB metadata를 서빙에 연결하는 변경도 없다.
  **이번 PR은 자동 산출물의 독립 리뷰 단계이며 배포용 최종 수정이 아니다.**

작성자 offline 산출 확인(독립 QA 아님): 기존 공식 원문 379 chunk 중 34개
주석 생성, 345개 원문만 유지. 정의 40은 실제 supplement content 지문과 일치한다.
체크인 fixture는 정의 40 외 12개 조항: 11개 산출, 5.05(b)(4)는 미완결 괄호로
보류. 실제 원문은 기존 PDF 검증 코퍼스에서 가져왔고 이번에 새 PDF 대조하지 않았다.
표본의 원문 인용·분해 범위는 리뷰어가 독립 판독해야 한다.

### 삼식 실행·판정
1. `node scripts/qa/official-parenthetical-structure-smoke.mjs`
   (13개 공식 조항 및 변조·revision·중첩·절단·부정·비제외 경계).
2. 기존 보호 환경에서 동일 고정 예산으로 base/자동 후보를 비교한다.
   집중 `--suite=exclusion-focus --reps=5`: 각 40회,
   원본 `--suite=original --reps=3`: 각 54회,
   실사용 공식 질문 81개 각 1회(기존 리뷰 하니스).
   후보만 자동 생성 manifest를 `--annotations`에 전달한다.
   입력 corpus 전체에 동일 파서를 적용하며 정의 40만 선별하지 않는다.
   자동 manifest `/Volumes/T7-Dev/reviews/runtime/excl-auto-v1-final.json`,
   추출 보류/노출 목록은 같은 경로의 `.report.json`.
3. 재생 전 exact SHA에서 새 경로로 재생성 가능:
   `node scripts/baseball-qa/rag/emit-official-parentheticals.mjs --corpus=<공식 JSONL> --canonical-url=<검증된 원 URL> --out=<새 절대 경로>`
   기존 corpus: `/Volumes/T7-Dev/reviews/runtime/genius-rule-v31.2evz6zli/state/rulebook-v31-final.jsonl`.
   emit은 네트워크/DB 접근 없고, 생성 파일은 수기 편집하지 않는다.
4. 결론 오판정·설명 역전/누락·보류·원문 양성 및 이웃 의도 손실·token/지연과
   주석 노출을 별도 판독한다. 자동화가 예전 수기 후보와 같다고 가정하지 않는다.
   실사용 81문항은 기존 하니스의 model-evidence 지점에 같은 manifest를 적용한다.

타입체크·lint·loader dry-run 확인. 독립 smoke/모델 재생은 미실행(삼식 담당).
graphify 갱신은 시도했으나 `ModuleNotFoundError: graphify`로 미완료.

## R3 / PR再작업 R1 — B1~B3 수정 (현재 계약)
앞의 R2는 철회된 설계 기록이다. 자동 후보 모델 재생 결과는 아직 없다.

- B1: `annotationContentDigest`를 생성기/하니스에서 공유한다. 공백 전체 제거
  SHA256(기존 하니스 계약)이며, 정확한 원문 해시는 별도 structure 안에 유지한다.
  자동 후보는 URL·공백 정규화 해시뿐 아니라 실제 source revision도 대조한다.
- B2: 보호된 읽기 전용 `genius_rag_serving_chunks`를 export했다. source snapshot을
  전후 비교하고 active generation/revision/URL을 결속했다. 13 source/9,152청크
  (기존 12 source/9,150 + #1515 보충 1 source/2청크)에서 주석 78개를 산출했다.
  관계 109개: exclusion 51 / qualifier quote 58. OR 분해는 여전히 정의40 1개뿐이다.
  따라서 일반 병렬 의미 분해의 폭넓은 입증으로 주장하지 않는다.
- 기존 cand-probe의 고유 근거 14개 중 구조화 가능 2개가 모두 새 manifest와
  URL/revision/공통해시 일치했다. 모델 재호출 없이 확인한 노출 사전 점검이며
  실제 generation의 40/40 노출 또는 회귀 QA를 대신하지 않는다.
- 실제 DB 경계의 규칙/리그규정/야구규약 16청크·15 section을 새 fixture에 보존했다.
  원문 PDF 줄바꿈 잔재는 보정하지 않았다. section은 DB의 페이지/조항 주소다.
  이전 13조항 fixture는 파서 단위 경계 증거로만 남긴다. 서빙 효과 근거가 아니다.
- B3: 공식 loader diff를 base 대비 완전히 제거했다. revision/needsRefresh/metadata
  쓰기 변경 없음. 별도 offline ingestion sidecar이므로 source stale·재임베딩 0.
  향후 제품 연결/metadata-only 이관은 source별 대상 수·비용·롤백·독립 QA를
  제시하는 별도 단계다. 이번 작업에서 DB 적용/전체 refresh는 하지 않는다.

현재 재생 입력:
`/Volumes/T7-Dev/reviews/runtime/excl-serving-r1-annotations.json`
대응 원문/일관성 증거:
`/Volumes/T7-Dev/reviews/runtime/excl-serving-r1.jsonl` 및 `.snapshot.json`.
재산출(네트워크 없음):
`node scripts/baseball-qa/rag/emit-official-parentheticals.mjs --corpus=/Volumes/T7-Dev/reviews/runtime/excl-serving-r1.jsonl --out=<새 경로>`
미적용 v3.1 corpus 입력은 이제 거부한다. 임의 URL 덮어쓰기도 제거했다.

삼식 재리뷰: 동일 집중8×5·원본18×3·실사용81×1, base/자동 후보 동예산.
후보는 위 새 manifest 사용. smoke는 실제 서빙 fixture의 digest/revision/render도
검증한다. 코드 smoke/모델 재생 실행·판정은 삼식 담당이다.

## PR 재작업 R2 — 의미 단정 보수화
삼식 R1(673db6bb): 집중 결론 오판정5/40→0/40, 원본 unsure4→3, 뒤엉킨 설명1→2. 실사용81 중 주석 노출12건, 플라이아웃 후보 오답1건. 방향 검증이며 GO/회귀 해소 아님.

- v2: 조사 종결·범위어·단서어·쉼표·범위기호는 분해/제외 단정 없이 원문 인용. 규칙/질문별 목록 없음.
- 같은 스냅샷: 주석78/관계109 유지, 제외51→26, 인용58→83. 잔존26관계/27항목 전수 판독: official-parenthetical-r2-audit.md.
- 후보: /Volumes/T7-Dev/reviews/runtime/excl-serving-r2-annotations.json
- 삼식 실행: genius-infield-evidence-live.ts --suite=flyout-regression --reps=5. base는 annotations 없음, 후보는 위 파일, 각각 별개 절대 --out. 질문은 정확히 “그건 플라이아웃 아니야?”. 원응답/최종답·근거·노출·아웃 효과 역전/unsure/error/timeout 구분. 0/5도 영향 완전 배제 아님.
- 정의40 주석 본문 동일: 기존 집중 재생 근거 재사용 가능. 변경된 인용 및 의미 역전3종 smoke는 독립 확인 필요.
- 서빙 연결 PR 전 레코드북·가이드북 실제 질문/근거/정답표를 고정해 동예산 회귀. 이번은 offline sidecar만, src/loader/DB 변경 없음.
- 재작업 누계2회. 머지 판정 요청 아님.
