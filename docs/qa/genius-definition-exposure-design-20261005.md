# 직접 정의 근거 노출 측정 설계 R1 — 생성 재생 없음

상태: 설계 리뷰 요청. 구현·실행·효과·머지·배포 승인 아님. Notion SSOT: https://app.notion.com/p/R0-2026-10-05-3efc901bb37281b7a87cff1b13055538

## 1. 기준과 기존 실패의 수용

- 요청 기준 `07bfae497f83230a9c0be9f98b7d65aee7b5f346`은 조회된 최신 origin/main `96a215ebc70b6bd687cdb1da91834f9fa90c0b5d`의 조상이다. 새 작업은 이 최신 main에서 분기했다.
- #1537 `6696de5d37e040085701b9527325578351959933`: 구현 smoke GO / 효과 HOLD. 전송40/40·노출20/20 통과와 의미 효과를 분리한다. 문맥 명시 역전4/10, 단독 TERM_CONTEXTUAL 보류9/10, 의미 적합 GROUNDED 양 suite0→0. GENERAL1→5는 보고용이다.
- 실행은 reg base10→closed10, ctx closed10→base10의 블록 AB/BA였다. 초기 manifest의 rep 교차 계획과 차이가 있었고 개별 rep 인과쌍은 아니다. #1535/1537 간 원인·통계적 악화 확정도 하지 않는다.
- 원본18·fair-catch 생성 확장 및 태그 변형 재생은 중단한다. 기존40/154/484 호출 예산은 본 측정의 권한으로 승계하지 않는다.

## 2. 질문과 증거 기준을 먼저 고정

측정 대상은 “원문에 정규 포구→타자 아웃이라는 직접 근거가 있고, 그 근거가 질문에 맞게 모델 입력까지 온전히 전달됐는가”다. 답변을 만드는 실험이 아니다.

원자적 의미 단위:
1. CATCH_ACTION: 정규 포구라는 잡는 행위의 원문 정의.
2. BATTER_OUT_EFFECT: 해당 플라이가 정규로 포구되면 **타자**가 아웃이라는 원문 법리. 주체·조건·효과 및 이를 지배하는 머리말까지 필요하다.
3. CATCH_VS_FLYOUT_RELATION: 포구 행위와 플라이아웃 결과의 관계. 위 두 단위를 결속하거나 원문이 관계를 직접 명시해야 한다. 단일 조건→효과 조항만 있으면 BATTER_OUT_EFFECT에는 충분할 수 있어도 행위 정의까지 자동 충족시키지 않는다.

`DIRECT_COMPLETE / DIRECT_PARTIAL / RELATED_NOT_DIRECT / ABSENT_IN_THIS_STAGE / UNVERIFIED`를 단위별로 기록한다. “포구”와 “아웃”의 공존이나 p60 파일명은 판정 근거가 아니다. 다른 주체(주자), 다른 조건(인필드 플라이 선고), 기록원 희생플라이, 고의낙구 부정 조항은 관련/반례로 분리한다. 불명확한 판독은 UNVERIFIED이며 reviewer 합의 전 정답 근거로 승격하지 않는다.

## 3. 기존 보존 입력에서 확인한 출발점 — 현재 서빙과 구분

고정 입력은 `definition-exposure-20261005/manifest.json` 및 해시 결속된4개 JSON이다. 생성 출력은 새 입력에서 제외했으며 기존 결과를 재생하지 않는다. 입력의 구현 SHA는 #1537이고 최신 main에서 새로 측정한 payload라고 부르지 않는다.

- 검색 후보는12개. 단독/문맥 동일 query의 보존 스냅샷이다. 실제 번들은 단독 primary6/physical7, 문맥 primary6/physical6이다.
- 검색 rank11 p60은 단독 형제로 노출되지만 내용은 제3스트라이크·번트파울·인필드 플라이 선언·타구 신체 접촉이다. 정규 포구→타자 아웃 조항이라고 셀 수 없다.
- rank2 p65의 “정규로 포구”는 **주자 리터치 어필 아웃**이다. rank5 p150은 희생플라이 기록, rank6 p66은 주자 접촉 조항이다. 관련 단어가 있어도 직접 근거가 아니다.
- R0 독립 리뷰(1791130993.527529): 검색12행의 CATCH_ACTION/BATTER_OUT_EFFECT DIRECT는 모두0/12. 10/02 `excl-serving-r1.jsonl` 규칙집119페이지, revision `sha256:de8715105c8984be`·`sha256:07651ec70e392723`에서 두 단위는 ABSENT_CORPUS다. p58=5.08, p59 없음, p60=⒜⑶ 중간부터여서 5.09⒜ 머리말·⑴ 포구 조항이 없고, p194=14 CALLED GAME·p195=16/17 CATCHER로 정의15 CATCH가 결손이다. 이는 해당 역사적 revision에 한정한 판정이며 현재 서빙 판정은 Phase 0b 재결속 전 UNVERIFIED/HOLD다.
- 따라서 #1537에서 p60 노출을 포구 정의 근거의 노출로 치환하지 않는다. 역전 감소와 직접 정의 정답 회복은 계속 별개다.

## 4. 측정 층위·결속 계약

각 fixture/의미 단위마다 다음 칸을 별도로 채운다:
`서빙 코퍼스 원문 존재 → 검색 반환/rank → primary 선택 → 800 UTF-16 cap 절단 → rawEvidence(형제 포함) → guardEvidence → modelEvidence → 최종 직렬화 자료 블록 → 실제 provider body`.

- 식별자는 URL/revision/sectionPath/원문 SHA256 네 항목이다. 변환 후 contentSha256은 별도로 보존하며 sourceContentSha256과 같아야 한다고 강제하지 않는다. cap은 source→derived lineage로 검증한다. sectionPath만 같은 다른 청크를 합치지 않는다. 전체 스냅샷 파일 SHA·순서·거리도 보존한다.
- 원문은 UTF-16 half-open span, 필요 머리말/조건/효과는 각각 span으로 결속한다. 전체 원문 SHA 및 span text SHA가 같아야 한다. 부분 문장·부정/예외 경계가 잘리면 PARTIAL이지 COMPLETE가 아니다.
- modelEvidence의 객체 존재와 payload의 실제 자료 영역 노출을 구분한다. 헤더/주석/질문/직전 답변의 단어를 원문 근거로 세지 않는다.
- 형제 JSON은 기존 envelope를 파싱하고 decoded 원문의 span과 직렬화 body 범위를 매핑한다. JSON의 `\\n` escaping 때문에 원문 단순 substring이 없다는 이유로 누락 판정하지 않는다. provenance/escaping 역매핑 실패는 UNVERIFIED/HOLD다.
- 파생 머리말이나 라벨은 grounding 원문으로 세지 않는다. 원문으로 추적 가능한 원본 머리말이 필요한 의미 단위는 별도 source span을 붙인다. 다른 조항을 상식으로 이어 붙이지 않는다.
- 오프라인 request preview는 실제 전송 증거가 아니다. #1537의 역사적 전송 일치40/40은 유지하되 새 main의 실제 provider 노출은 UNVERIFIED다.
- guardEvidence와 final source 선택도 별도 열이다. 이번 생성0 측정에는 final 답변/출처가 없으므로 N/A이지 PASS가 아니다.

## 5. 단계별 실행과 중단

### Phase 0 — 보존 입력 감사(설계 리뷰 대상)

단독/문맥2개 입력, 검색 원문12개 전수. 추가 네트워크·생성·DB쓰기0. 12개 원문을 reviewer가 CATCH_ACTION/BATTER_OUT_EFFECT별 판독하고, 각 층위 원문 식별자와 span을 대조한다. 작성자 판독은 reviewer QA를 대체하지 않는다. 알 수 없는 해시/identity/범위 불일치면 HOLD, 데이터 수리·추정·자동 fallback 없음. 검증된 cap prefix 절단은 아래 계약에 따라 DIRECT_PARTIAL로 기록하며 HOLD로 오인하지 않는다.

### Phase 0b — 현재 서빙 revision 원문 존재 재결속(Phase 1의 선행 게이트)

10/02 인벤토리 파일 SHA·119개 규칙집 행·두 revision·행별 URL/section/content hash를 고정한다. 현재 서빙의 읽기 전용 전체 규칙집 인벤토리에 조회 시각·출처·페이지네이션 완결성·행 수·revision 집합·정렬된 행 식별자/content 해시 집합 서명을 남겨 역사 자료와 대조한다. revision 문자열만 같아도 행/본문이 다르면 동일 스냅샷으로 간주하지 않는다. 현재 자료 미확보 또는 불완전 조회는 UNVERIFIED/HOLD다. 변경 revision이면 새 전체 원문을 독립 판독하고 옛 ABSENT를 승계하지 않는다.

동일성이 재확인되면 CATCH_ACTION/BATTER_OUT_EFFECT를 현재 revision의 ABSENT_CORPUS로 확정하고 Phase 1 세 요청 capture를 보류한다. 다음은 #1401 v3.1 재적재 트랙의 원문 누락 보완·서빙 반영 검증이다. #1401은 미실행이며 이 설계가 ingestion/DB쓰기·재적재·배포를 승인하지 않는다. 재적재 후 새 revision에서 직접 원문 존재가 검증되어야 Phase 1을 다시 검토한다. 원문 존재 확인만으로 실행 승인까지 자동 승계하지 않는다.

### 절단 계약 — 검색→rawEvidence

800 UTF-16 unit cap의 알려진 변환은 원문 prefix [0,min(800,N))와 파생 본문을 정확히 대조하고 source/derived SHA를 각각 기록한다. N>800이면 소실 span [800,N), 소실 원문·SHA·단위 수를 남기고 노출 완전성은 DIRECT_PARTIAL이다. 동일 URL/revision/section이어도 prefix 불일치면 UNVERIFIED/HOLD다. 원문 정체성/변환 검증과 의미 적합성은 별도 열이다. p150은 808→800, 소실 [800,808)로 DIRECT_PARTIAL이지만 CATCH_ACTION/BATTER_OUT_EFFECT의 의미 라벨은 RELATED_NOT_DIRECT 그대로이며 직접 근거로 승격하지 않는다. 777자 INFIELD FLY는 cap 통과이며 경계 smoke는 799/800 온전·801 한 unit 소실을 포함한다. 필요 머리말/조건/효과 span과 소실 span의 교집합도 따로 기록한다.

### Phase 1 — 최신 main의 생성 없는 capture(아직 구현·실행 승인 아님)

Phase 0b에서 직접 원문 존재가 확인되고 별도 scripts-only 구현·독립 smoke GO·실행 허용이 결속된 뒤에만 진행한다. ABSENT_CORPUS이면 이 단계는 실행하지 않는다. 고정 요청은 단독 “그건 플라이아웃 아니야?”, 같은 질문+승인222자 직전 턴, 명시 포구 대조 “타자의 페어 플라이 타구를 야수가 땅에 닿기 전에 정규로 포구하면 타자는 아웃이야?” 3개다. 마지막 요청은 **검색/전달 대조**이며 original18/fair-catch 생성 확장을 재개하는 것이 아니다.

- 담당: 삼순 구현/manifest, 삼식 독립 측정/판정. 최신 main exact SHA·검색 설정·resolved 모델 설정·고정 now·fixture 전체 해시·corpus revision을 실행 전 고정한다. 현재 fresh snapshot/now가 미준비이므로 manifest에 명시적으로 HOLD한다.
- 의미를 바꾸지 않는 관측 훅으로 원래 선택과 request builder까지 기록하고 모델 전송 직전에 중단한다. normalizeQuestionLlm/callLlm/callOfficialRagLlm을 포함한 생성 호출은 전부0. 해당 경로가 모델을 요구하면 응답을 꾸며 계속하지 않고 HOLD한다. 서빙 코드·prompt·분류·후처리 변경 금지.
- 외부 읽기는 별도 capture 허용 후에만 한다. 요청당1회 capture(3요청), 고유 검색 query당 최대1회 검색/embedding(최대3); 재시도 없음. 생성 endpoint는 차단한다. 필요 query가 늘거나 호출 경로가 미확정이면 실행 전 HOLD한다. 이 허용은 현재 설계 제출에서 실행하지 않는다.
- 원문 존재 판정은 Phase 0b에서 완료한다. RPC 상위12건에 없다는 것만으로 ABSENT_CORPUS 판정 금지.
- 완성 capture snapshot 밖 질의는 live fallback 없이 HOLD. 검색/선택 상한6·물리7·형제1·문맥/recordbook skip 유지. p60/p59 pinning·질문regex 라우팅·수기답·보충적재·재정렬·renderer 변경 금지.
- fake 모델 응답을 넣어 final 경로를 통과시키지 않는다. dry capture는 generation 결과가 아니라 직전 요청 준비까지만 측정한다.

## 6. 무엇을 결정할 수 있는가

- 원문 ABSENT_CORPUS: capture 보류, #1401 v3.1 원문 누락·재적재 트랙과 연결(미실행·별도 승인).
- 원문 존재 미확인: source 인벤토리 확인 과제. 검색/생성의 탓으로 단정하지 않는다.
- 검증된 직접 원문은 있으나 검색 반환 없음: 검색 후보 도달 문제의 증거. 선택/렌더 변경은 아직 안 한다.
- 검색 반환엔 있으나 선택 없음: 선택 손실. 상한 우회나 특정 페이지 강제 선택의 승인이 아니다.
- 선택/raw엔 있으나 payload엔 없거나 PARTIAL: 조립·절단 경계 문제. 정확히 사라진 span으로 보고한다.
- 직접 원문 COMPLETE가 payload에 있고도 기존 답이 잘못됨: 그때 생성 의도/범위 해석 가설을 별도 설계한다. 새로운 생성 재생은 별도 사전 기준·예산·승인이 필요하다.

합격은 응답 품질 PASS가 아니라 “모든 칸에 검증 근거 또는 명시적인 UNVERIFIED를 남겨 혼동하지 않음”이다. 다음 변경 축을 선택할 근거가 없으면 설계를 HOLD한다. GENERAL과 GROUNDED, raw와 final, 역사적 입력과 현재 입력을 섞지 않는다.

## 7. 후속 구현 smoke 계약(이번 문서에는 실행 코드 없음)

잘못된 revision/hash, p65 주자 아웃을 타자 아웃으로 오판, p60 존재만으로 긍정 판정, 질문/직전 답변의 문구를 근거로 오판, 머리말/부정어 절단, nested JSON escaping, 같은 sectionPath의 다른 content를 필수 음성 대조로 둔다. 정상 요청 내용·순서·settings·extras byte-identical, 추가 생성0, guarded stop-before-model을 검증한다. 오프라인 assertion/negative fixture PASS는 독립 의미 판독을 대체하지 않는다.
