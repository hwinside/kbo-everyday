# 타구 위치 질문의 사전 정의 대체 차단 — R1

## 근거·범위
최근24h 원장(2026-11-18 11:30–11-19 11:30 KST): 5질문/3계정, 실제 DM 5/5 대조. 자연사용 여부는 계정 신원 미확인으로 단정하지 않는다.
Q3808133 → Q3808135 → Q3808137: 미확인 표현 → 3루/2루 사이 안타 설명 → 위치 이름 재질문. 중간 답은 안타 일반 정의(dictionary), 마지막은 numeric_not_in_question으로 unsure.
기준 main 846eec117ac397cae338aa8b2c94495e30aa23f5.
기존 #1541은 공식 RAG 정의 주체·근거 수용, #1629는 미확인 용어 판정이며 이 패치는 앞단 사전 매퍼의 실제 답변 충분성 계약만 변경한다. 해당 PR의 NO-GO/재작업 횟수를 초기화하거나 해소한 것으로 보지 않는다.

## 변경
같은 매퍼 호출에 검수 answer를 추가하고, 질문 전체에 대한 충분성을 먼저 판단하도록 한다. baseball + answerSufficient===true + 제공된 비어 있지 않은 후보 answer가 있어야 선택한다. 누락/문자열 true/다른 분야/후보 밖은 null. 모델 생성문은 서빙하지 않는다. 호출 수·timeout·토큰 집계·exact 사전 경로·숫자 검증은 그대로다.
충분성 자체는 모델 판정이므로 오판 가능성은 남는다. null 증가로 후속 provider 비용/지연이 늘 수 있다. 답변 제공 복구나 숫자 검증 해결을 주장하지 않는다.

## 독립 QA (삼식 실행)
1. `npm run qa:genius-glossary-map` 및 기존 baseball-qa 게이트. 파서에서 충분성 조건 제거, 후보 answer 빈 값 검사 제거 변이 각각 RED 확인.
2. base/head 각각 `npm run qa:genius-glossary-map-live`: 기존 양성/반대 사례와 위치 4종×3회. head 위치 행은 모두 null, 안타 정의/유격수/도루/약어 양성 유지. answer 전달 제거 또는 충분성 지시 제거 변이는 실제 provider 결과를 보존해 판정(살아남으면 보고; RED 단정 금지).
3. 전체 경로 paired 36행(18×base/head), 각 variant의 실제 provider 사용:
```
npx tsx scripts/qa/genius-game-conversation-replay.ts --live --input=scripts/qa/fixtures/genius-location-20261119.json --snapshots=scripts/qa/fixtures/genius-location-snapshots-20261119.json --base-root=<846eec11 worktree> --out=<review-root>/paired-location.json
```
환경은 기존 보호된 reviewer 설정으로 공급. 원질문 3턴×3회와 안타 정의·유격수 정의·보크 응용 controls. 실제 답변·경로·선택 문맥·provider trace/토큰·지연·오류를 전수 대조하며 성공만 골라 재실행하지 않는다.
4. 원질문에서 안타 정의 대체가 없어도 unsure로만 바뀌면 **답변 품질 개선 미입증/HOLD**. 위치 명칭 답변의 정확성과 기존 controls 무회귀를 별도 판정한다. 숫자 가드를 약화해 통과시키지 않는다.
5. 승인·배포 후 전용계정 실제 UI→DM, 저장=화면 및 정리 확인. 작성자 실행0, 자연사용 효과 미검증.

## 작성자 확인
제품 tsc --noEmit PASS. diff-check PASS. Graphify 재생성 시도는 ModuleNotFoundError(graphify)로 미갱신. 독립 QA/paired/운영 QA 미실행.
