# 공식 규칙 정의 누락 복구 — 적용 전 리뷰 패키지

## 원인과 범위

- 실제 Q2264235(2026-10-01 20:49 KST) `이사에서는 인필드 플라이가 없어?`에 2아웃에도 가능하다는 DM이 발송됨. 로그는 `match_path=llm`, `rag_attempt_path=official`, 거리 0.252734727913008, discard 없음. 과거의 정확한 모델 원응답/검색 집합은 이 로그에 없으므로 재생 결과와 구분한다.
- 현재 서빙 뷰를 공백 제거한 인필드/INFIELD FLY로 대조: 규칙서에는 5.09의 선언 후 효과·예외 3청크만 있고 정의 40번은 없다. 연감의 실제 경기 서술은 성립 조건의 정의를 대체하지 않는다.
- 공식 생성 경로는 자료가 답을 담지 못하면 GENERAL을 허용하고 이를 `llm`으로 기록한다. GENERAL의 숫자 회피 지침은 베이스 조건을 ‘모든 베이스’처럼 바꾸게 한다. 이번에는 누락된 근거를 복원해 이 경로로 빠지는 원인을 먼저 제거한다. 생성 프롬프트·숫자 검증·검색 임계·라우팅 변경은 없다.
- #1393 전체 코퍼스 재적재는 품질 회귀로 롤백됐다. #1401의 v3.1 추출기는 main에 있지만 전체 379청크 재적재는 미승인이다. 이번 변경은 기존 코퍼스 교체가 아니라 별도 source의 정의 40번 전체 2청크다. #1391 짧은 규칙 질문 PR과 독립 범위다.

## 원문·산출물

2026-10-02 공식 CDN PDF를 다시 내려받아 기존 페이지 추출본 205페이지와 대조했다. 물리 201–202쪽(인쇄 177–178쪽), 정의 40번: 무사/1사, 주자 1·2루/만루, 직선타구·번트 제외, 평범한 수비, 심판 선고, 볼 인 플레이·파울·수비방해 예외를 보존한다. 정의 전체 2조각, 최대 777자. 수기 답변 요약이 아니다.

- PDF SHA256: `deb2c0d58ef41c6631f47a3dcfbe37d853a97275b9891ad50f0a8525b302a16a`
- JSONL SHA256: `9bb03ae5dc30c94c84541a5f1e0edb5c82538967dcfbfa6ba94768a6189df97e`
- source: `kbo:ebook:2026-공식야구규칙-필수-조항`
- loader revision: `sha256:07651ec70e392723`
- dry-run: 1 source / 2 chunks, skips 0, 예상 임베딩 1배치. 실제 DB 쓰기·임베딩 호출 0.

재현: 기존 `prepare-rulebook-corpus.py`에 전체 페이지 JSONL과 위 PDF를 넣고 `--output`/`--audit`를 만든다. 이어 `select-rulebook-supplement.py --input=<output> --audit=<audit> --section='40. INFIELD FLY (인필드 플라이)' --output=<supplement>`로 선택한다. 선택기는 원문 검증 audit/hash·섹션 전체를 결속하며 질문 키워드를 다루지 않는다.

## 독립 리뷰·QA

1. 원문 PDF와 2청크를 대조하고 기존 `qa:genius-required-rule-corpus`, 공식 loader·규칙/RAG 게이트와 CI를 실행한다. 신규 fixture는 partial/duplicate/원본 source 덮어쓰기/PDF hash 변조를 거절해야 한다. 이 계약 검증은 의미 정답률이 아니다.
2. `npx --no-install tsx scripts/qa/genius-infield-evidence-live.ts --out=<absolute-path> --reps=3`로 현행 검색·생성·최종 답변을 관측한다. 같은 실행에 `--supplement=<absolute-jsonl>`을 주면 추가 자료를 임베딩해 기존 검색 후보와 거리순으로 합치는 사전 실험이다. 운영 검색 성공으로 보고하지 않는다. 보호된 환경변수로 실행하며 로그/DM/cache/계정 쓰기는 하지 않는다.
3. 18문항 × 3회 고정 예산: 원문 질문과 2사, 무사/1사/2사 × 1루/1·2루/만루, 번트·직선타구·볼데드, 타격방해/송구방해/미지정 실제 장면/DH 대조. 원문 전체를 읽어 조건·제외·답변 경로를 평가한다. 모델 오류/unsure를 성공으로 세지 않으며 잘못된 긍정은 0건이어야 한다. 통과할 때까지 반복 금지.
4. source 2청크만으로 생성 오류가 남으면 NO-GO로 원인을 추가 수정한다. 무조건 자료 추가만으로 완료했다고 판정하지 않는다.

## 적용·롤백 게이트

exact SHA 삼식 GO 후, 코드 머지와 이 source 2청크 적재·임베딩 범위를 명시해 하린아빠 승인을 요청한다. 코드만 머지해도 데이터는 자동 적용되지 않는다.

적용 직전 기존 모든 공식 source의 revision/generation/content/embedding 지문과 새 key 부재를 읽기 전용으로 확인·보존한다. 동일 key가 이미 있거나 예상치 못한 변경이 있으면 중단하고 인수한다. 보호 egress의 기존 loader에 정확한 JSONL/manifest/전용 state를 지정하고 `--protected-egress --apply`를 사용한다. `--refresh`, 전체 379청크 교체, 기존 source 변경은 제외한다.

적용 후 2청크·768차원·원문/URL/revision·READY·기존 source 지문 불변을 확인한다. 삼식이 supplement 옵션 없는 실제 RPC/생성 재검증과 전용 계정 UI QA를 실행한다. DB 검증과 UI QA를 구분한다.

롤백은 함께 제출한 SQL로 새 source만 tombstone한다. identity/PDF/revision/content/lease를 결속하며 기존 데이터·벡터는 삭제하지 않는다. SQL은 수동 검토용이며 실행하지 않았다.

후속 순서: #1513 live Timeout 집계 → 띄어쓰기 관측 −10%p → ‘워닝’ 단독 연결. 이 PR에 혼합하지 않는다.
