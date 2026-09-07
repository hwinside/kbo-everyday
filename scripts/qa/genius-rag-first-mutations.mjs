#!/usr/bin/env node
/**
 * RAG-first 라우팅 게이트의 **검증력 증명**.
 *
 * 계약: 원본을 in-memory 백업 → 결함 주입 → smoke 재실행 → 의도한 FAIL 마커가 나와야 RED.
 * 앵커 부재 = 러너 고장으로 MISS (조용한 skip 금지). 종료 시 무조건 원복.
 *
 * ⚠️ 왜 이게 필요한가 — 1차 게이트는 소스 grep 뿐이라 `isSupportedRuleTermQuestion` 이
 *   진입 조건에서 빠졌다는 것만 보고 GREEN 을 냈고, 실제로는 `llm_scope_gate` 가 같은 문을
 *   닫고 있었다. **selftest 통과는 아무것도 증명하지 않는다** — 실제 결함을 주입해
 *   RED 가 나야 그 축이 살아 있는 것이다(M90).
 *
 * 🔴 2026-08-27 ⓒ 범위로 재작성. 소유권 판정(잔여질문 probe·전용 임계)을 이 PR 에서
 *   걷어냈으므로 그 축(구 r3~r7·r13)은 **없는 결함을 주입하는 셈**이라 폐기하고,
 *   대신 ⓒ 의 실제 계약("엔티티 결속 질문은 main 그대로")을 뚫는 변이로 교체했다.
 *   mutant 가 결함이 아니면 그건 게이트 결함이 아니라 내 변이 결함이다.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const RETRIEVE = "src/lib/baseball-qa/rag/retrieve.ts";
const SERVER = "src/lib/baseball-qa/server.ts";
const SMOKE = "scripts/qa/genius-rag-first-routing-smoke.ts";

const MUTATIONS = [
  {
    name: "r74 canonical alpha rank IDs regress to numeric-only",
    file: "src/lib/baseball-qa/stats/rank-request-context.ts",
    from: "return /^(?:\\d{1,8}|[A-Z]{2}\\d{3})$/.test(id) ? id : undefined;",
    to: "return /^\\d{1,8}$/.test(id) ? id : undefined;",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r75 unqualified missing AVG rejects the full snapshot",
    file: "src/lib/baseball-qa/stats/question-operation.ts",
    from: "const noAverage = row.avg === \"-\" && Number(row.qualifiedRate) === 0;",
    to: "const noAverage = false;",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r76 qualified foreign players are silently excluded",
    file: "src/lib/baseball-qa/stats/question-operation.ts",
    from: "canonicalRows.push({ ...row, kbo_id: id, player_key: id });",
    to: "if (/^\\d+$/.test(id)) canonicalRows.push({ ...row, kbo_id: id, player_key: id });",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r73 unsupported named rankings fall through to scalar values",
    file: PIPELINE,
    from: "hasPlayer && !isRankAsk(question) ? unavailable(RANK_SCOPE_ANSWER) : null;",
    to: "null;",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r69 scalar handlers steal requested operations",
    file: PIPELINE,
    from: "const operationAnswer = await answerRequestedOperation(question, context, players, deps, pickedCandidate);",
    to: "const operationAnswer = null;",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r70 remaining request is replaced with games played",
    file: "src/lib/baseball-qa/stats/question-operation.ts",
    from: "${KBO_REGULAR_SEASON_GAMES - row.games}경기",
    to: "${row.games}경기",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r71 club request is ranked across the league",
    file: "src/lib/baseball-qa/stats/question-operation.ts",
    from: 'const ranked = rankByStat(rows.filter((row) => row.avg !== "-"), "avg");',
    to: 'const ranked = rankByStat(canonicalRows.filter((row) => row.avg !== "-"), "avg");',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r72 exact previous-message request metadata is lost",
    file: "src/lib/baseball-qa/previous-turn-row.ts",
    from: "...(rankRequestContext ? { rankRequestContext } : {}),",
    to: "// rank context discarded",
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r68 clip source before official context repair loses closing effect",
    file: RETRIEVE,
    from: 'const row = repairKnownOfficialRuleContext(original, RAG_EVIDENCE_MAX_CHARS);',
    to: 'const row = repairKnownOfficialRuleContext({ ...original, content: original.content.slice(0, RAG_EVIDENCE_MAX_CHARS) }, RAG_EVIDENCE_MAX_CHARS);',
  },
  {
    name: "r65 official appendix presentation repair removed",
    file: RETRIEVE,
    from: 'const row = repairKnownOfficialRuleContext(original, RAG_EVIDENCE_MAX_CHARS);',
    to: 'const row = original;',
  },
  {
    name: "r66 official appendix repair leaks to other source grades/kinds",
    file: "src/lib/baseball-qa/rag/official-rule-context.ts",
    from: 'if (row.sourceGrade !== "tier1" || row.sourceKind !== "kbo_ebook") return row;',
    to: 'if (false) return row;',
  },
  {
    name: "r67 official appendix repair leaks to other rulebook editions",
    file: "src/lib/baseball-qa/rag/official-rule-context.ts",
    from: 'if (row.pageTitle.replace(/\\s/gu, "") !== "2026공식야구규칙") return row;',
    to: 'if (false) return row;',
  },
  {
    name: "r61 공식 복합 정의에서 사용자 인용 수량 소실",
    file: PIPELINE,
    from: 'definitionQuestion: definition?.assessment ? definitionNumericSource(question, definition) : undefined,',
    to: 'definitionQuestion: undefined,',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r62 공식 수량 검증기에 사용자 인용 소스 미전달",
    file: RETRIEVE,
    from: 'definitionQuestion: options.definitionQuestion,',
    to: 'definitionQuestion: undefined,',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r63 동의 접두를 평가 요청으로 오인",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'Boolean(quantity || questionSeparator || /[?]/.test(predicate)) && ASSESSMENT_DIRECT.test(predicate)',
    to: 'ASSESSMENT_DIRECT.test(predicate)',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r64 사용자 인용 라이선스를 일반 정의까지 확장",
    file: PIPELINE,
    from: 'definitionQuestion: definition?.assessment ? definitionNumericSource(question, definition) : undefined,',
    to: 'definitionQuestion: definition ? definitionNumericSource(question, definition) : undefined,',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r55 복합 질문에서 평가 요청 소실",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'return { ...definition, assessment: { question: compound.assessment, mode: "context_required" } };',
    to: 'return definition;',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r56 모델 데이터에서 평가 요청 누락",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '...(frame.assessment ? { assessment: frame.assessment } : {}),',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r57 수량 재작성에서 평가 요청 소실",
    file: PIPELINE,
    from: 'assessment: definition.assessment, ',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r58 근거 없는 경로에서 기존 평가 근거 상태 재사용",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'mode: hasEvidence ? "grounded_only" as const : "context_required" as const',
    to: 'mode: frame.assessment.mode',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r59 복합 질문을 고정 사전으로 종결",
    file: PIPELINE,
    from: 'scopeGate || statDefinition?.assessment || statDefinition?.explanation === "plain_example"',
    to: 'scopeGate || statDefinition?.explanation === "plain_example"',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r60 복합 임계값 질문을 값 조회로 반환",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'const text = (splitStatDefinitionAssessment(question)?.definition ?? question).normalize("NFKC").toLowerCase();',
    to: 'const text = question.normalize("NFKC").toLowerCase();',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r52 일반 모델 경계에서 이전 공식 근거 상태 재사용",
    file: "src/lib/baseball-qa/gemini-request.ts",
    from: 'statDefinitionData(definitionWithEvidence(definition, false))',
    to: 'statDefinitionData(definition)',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r53 빈 검색 후 조건 나열 프레임·저장 상태 유지",
    file: PIPELINE,
    from: 'if (statDefinition) statDefinition = definitionWithEvidence(statDefinition, false);',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r54 수량 재작성에서 공식 근거 상태 소실",
    file: PIPELINE,
    from: 'evidence: definition.evidence, ',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r49 재설명 방식 저장 소실 — 다음 질문도 같은 방식 반복",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'explanationApproach: frame.reexplanation?.approach',
    to: 'explanationApproach: undefined',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r50 직전 답변 비교 데이터 모델 요청 누락",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '...(frame.reexplanation ? { reexplanation: frame.reexplanation } : {}),',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r51 수량 재작성에서 설명 방식·비교 대상 소실",
    file: PIPELINE,
    from: 'reexplanation: definition.reexplanation, ',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r48 재설명 요청에 고정 사전 답변 재사용",
    file: PIPELINE,
    from: 'scopeGate || statDefinition?.assessment || statDefinition?.explanation === "plain_example" ? null : matchGlossary(glossary, question)',
    to: 'scopeGate ? null : matchGlossary(glossary, question)',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r43 재설명 표현 모드 제거 — 같은 정의만 반복한다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'return { terms, followup, period, explanation, searchQuestion:',
    to: 'return { terms, followup, period, explanation: undefined, searchQuestion:',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r44 수량 재작성 시 쉬운 설명 소실",
    file: PIPELINE,
    from: 'explanation: definition.explanation, period:',
    to: 'period:',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r45 무문맥 쉬운 설명 요청 가드 제거",
    file: PIPELINE,
    from: '  if (isPlainStatExplanationRequest(question)) return hasContext ? "llm_scope_gate" : "context_missing";',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r46 값 질문 뒤 쉬운 설명을 정의로 강제 전환",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '  if (plainFollowup && !hasPreviousDefinition(context)) return null;',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r47 모델 요청에서 재설명 모드 누락",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'explanation: frame.explanation ?? "definition",',
    to: 'explanation: "definition",',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r38 generic 정의 주제 저장 제거 — 다음 기간 전환이 답변의 다른 지표에 흔들린다",
    file: PIPELINE,
    from: 'definitionContext: definitionContextFor(statDefinition),',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r39 공식 grounded 주제 저장 제거 — 같은 주제의 후속 프레임이 소실된다",
    file: PIPELINE,
    from: 'answer, source: "rag", sourceUrl,\n    definitionContext: definitionContextFor(definition),',
    to: 'answer, source: "rag", sourceUrl,',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r40 context selector 주제 전달 제거 — DB에 저장해도 후속으로 못 읽는다",
    file: "src/lib/baseball-qa/context.ts",
    from: 'const definitionContext = readStatDefinitionContext(row.definitionContext);',
    to: 'const definitionContext = undefined;',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r41 SQL row 주제 복원 제거 — 실제 서버 로딩 경로에서 프레임이 사라진다",
    file: "src/lib/baseball-qa/previous-turn-row.ts",
    from: 'const definitionContext = final?.source === row.job_source ? final?.definitionContext : undefined;',
    to: 'const definitionContext = undefined;',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r42 공식 GENERAL 주제 저장 제거 — 빈 근거 fallback 후 문맥을 잃는다",
    file: PIPELINE,
    from: 'statRuleTermVerified: Boolean(definition),\n      definitionContext: definitionContextFor(definition),',
    to: 'statRuleTermVerified: Boolean(definition),',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r33 정의 기간 전달 제거 — 모델이 시즌/통산 문맥을 잃는다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: 'period: frame.period ?? { scope: "unspecified", source: "none" }',
    to: 'period: { scope: "unspecified", source: "none" }',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r34 현재 질문 기간 우선순위 제거 — 통산 전환을 시즌으로 덮는다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '  if (explicit) return { scope: explicit, source: "question" };',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r35 재작성에서 기간 손실 — 수량을 고치며 문맥을 잃는다",
    file: PIPELINE,
    from: 'period: definition.period, repair:',
    to: 'repair:',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r36 무문맥 기간 질문 가드 제거 — 없는 지표를 추측한다",
    file: PIPELINE,
    from: '  if (isStatPeriodFollowupQuestion(question)) return hasContext ? "llm_scope_gate" : "context_missing";',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r37 기간 변경 시 이전 수치 인용 허용 — 시즌 숫자를 통산으로 옮긴다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '  if (previous && current && current !== "unspecified" && current !== previous) return question;',
    to: '',
    smoke: "scripts/qa/genius-period-context-smoke.ts",
  },
  {
    name: "r29 무문맥 참조 질문 가드 제거 — 없는 직전 주제를 생성한다",
    file: PIPELINE,
    from: '  if (!hasContext && isReferenceMeaningQuestion(question)) return "context_missing";',
    to: '',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r30 일반 답변 한글 수량 정규화 제거 — 질문 밖 177을 허용한다",
    file: RETRIEVE,
    from: 'const tokens = normalizeSinoKoreanQuantities(answer, QUANTITY_COUNTERS).match(',
    to: 'const tokens = answer.match(',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r31 한자어 수량 파싱 제거 — 표기별 검증 결과가 갈린다",
    file: "src/lib/baseball-qa/rag/sino-korean-quantity.ts",
    from: 'const value = cardinalValue(match[1]);',
    to: 'const value = null;',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r32 재작성 메타 발언 금지 제거 — 내부 검증을 유저 지적으로 오인한다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: '  "재작성 피드백은 내부 검증 결과이지 사용자의 지적이 아니다. 감사·사과·실수 인정·수정 예고·검증 과정 같은 메타 발언을 하지 말고 질문에 대한 설명만 답한다.",',
    to: '',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r24 공식 정의 재작성 제거 — 관형 한 폐기 후 정상 설명을 복구하지 못한다",
    file: PIPELINE,
    from: 'if (generatedOfficialNow && definition && validated.kind === "insufficient" &&',
    to: 'if (false && generatedOfficialNow && definition && validated.kind === "insufficient" &&',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r25 generic 정의 재작성 제거 — 새 1을 허용하지 않고 설명을 복구하는 경로 소실",
    file: PIPELINE,
    from: "if (generatedGenericNow && statDefinition && definitionNumberUnsupported())",
    to: "if (false && generatedGenericNow && statDefinition && definitionNumberUnsupported())",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r26 저장된 RAG 원답도 재호출 — 재생의 단일 winner 경계 우회",
    file: PIPELINE,
    from: 'generatedOfficialNow && definition && validated.kind === "insufficient"',
    to: 'definition && validated.kind === "insufficient"',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r27 저장된 generic 원답도 재호출 — 재생에서 추가 과금",
    file: PIPELINE,
    from: "generatedGenericNow && statDefinition && definitionNumberUnsupported()",
    to: "statDefinition && definitionNumberUnsupported()",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r28 재작성 뒤 근거 검사 제거 — 재작성된 환각 수량 유출",
    file: PIPELINE,
    from: "      validated = validateOfficial(llm);",
    to: '      validated = { kind: "grounded", answer: JSON.parse(llm.text).answer, toneCompliant: true };',
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r21 직전 사용자 숫자 제거 — 후속 10홀드 인용이 차단된다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: "return `${question}\\n${definition.context.question}`;",
    to: "return question;",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r22 generic 정의 대상 미전달 — 후속 지표·인용 의미를 잃는다",
    file: PIPELINE,
    from: "rosterBlock, statNumericGuard && !statDefinition, statDefinition ?? undefined)",
    to: "rosterBlock, statNumericGuard && !statDefinition, undefined)",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r23 공식 RAG 정의 대상 미전달 — 인용 숫자가 순위표로 흐른다",
    file: PIPELINE,
    from: "{ context: definition?.context, definition: definition ?? undefined }",
    to: "{ context: definition?.context, definition: undefined }",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r18 정의 fallback을 RECORD 분류기로 복귀 — 빈 검색 4턴이 정의답을 잃는다",
    file: PIPELINE,
    from: "rosterBlock, statNumericGuard && !statDefinition, statDefinition ?? undefined)",
    to: "rosterBlock, statNumericGuard, statDefinition ?? undefined)",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r19 정의 fallback 숫자 검증 제거 — 오타니 환각값이 유출된다",
    file: PIPELINE,
    from: "!numericTokensSubsetOf(definitionFallback.answer, definitionNumericSource(question, statDefinition))",
    to: "false",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r20 정의 검증 표식 제거 — log crash 재생이 정상답을 되묻기로 바꾼다",
    file: PIPELINE,
    from: "statRuleTermVerified: Boolean(statDefinition && statNumericGuard),",
    to: "statRuleTermVerified: false,",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r16 정의 후속 문맥 전달 제거 — 직전 홀드 질문이 모델에 도달하지 않는다",
    file: PIPELINE,
    from: "{ context: definition?.context, definition: definition ?? undefined }",
    to: "{ context: undefined, definition: definition ?? undefined }",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  {
    name: "r17 이유 질문 배제 제거 — 도루 불문율을 지표 정의로 오분류한다",
    file: "src/lib/baseball-qa/stats/definition-intent.ts",
    from: " && !REASON_ASK.test(text)",
    to: "",
    smoke: "scripts/qa/genius-stat-definition-smoke.ts",
  },
  // ── P0-1: 라우팅이 실제로 열렸는가 ──────────────────────────────────────
  {
    name: "r1 진입 조건에 scopeGate 복원 — 사전 밖 질문이 다시 문 앞에서 막힌다(1차 false-green 재현)",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    !scopeGate &&\n    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
  },
  {
    name: "r2 닫힌 단어 사전을 전면 복원 — 사전 밖 표현은 정본이 있어도 도달 못 한다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    (statDefinition || isSupportedRuleTermQuestion(question, glossary, players)) &&",
  },

  // ── ⓒ 계약: 엔티티 결속 질문은 main 그대로 ──────────────────────────────
  {
    name: "r3 엔티티 결속에도 개방 적용 — 사건 질문(`문보경 삼진 당한 경기`)을 규칙집이 선점한다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    true &&",
  },
  {
    name: "r4 구단을 엔티티 판정에서 제외 — `LG 트윈스 역사`를 규칙집이 가져간다",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    mentionsAnyRosterName(question, players);",
  },
  {
    name: "r5 선수를 엔티티 판정에서 제외 — `문보경 별명`을 규칙집이 가져간다",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    mentionedTeamCanonicals(question).length > 0;",
  },
  {
    // 🔴 삼순 2026-08-27 ① 회귀 변이. 직전 exact 가 정확히 이 상태였고 게이트는 GREEN 이었다.
    //   후보 해석기의 null 은 "엔티티 없음"이 아니라 "단일 후보로 못 좁힘"이라, 이 변이는
    //   `문보경 어제 무슨 일 있었어?`(0.3210)·복수 선수(0.3086)·복수 구단(0.2830)을 전부
    //   공식 RAG 로 흘린다 — 셋 다 임계 0.42 안이라 실제로 durable LLM 을 선점한다.
    name: "r15 지명 존재 → 단일·서빙가능 후보로 되돌림 (직전 exact 회귀 — 후보 null 집합이 샌다)",
    file: PIPELINE,
    from: "    mentionsAnyRosterName(question, players)\n    || mentionedTeamCanonicals(question).length > 0;",
    to: "    Boolean(enabledPlayerCandidate) || resolveRagTeamCandidate(question) !== null;",
  },
  {
    name: "r6 엔티티 결속 질문을 공식 경로에서 통째로 차단 — main 이 official 로 보내던 룰 질문이 죽는다",
    file: PIPELINE,
    from: "    (statDefinition || (ownedByEntityRag\n      ? isSupportedRuleTermQuestion(question, glossary, players)\n      : true)) &&",
    to: "    (statDefinition || !ownedByEntityRag) &&",
  },

  // ── 근거 판정이 개수가 아니라 거리라는 계약 ──────────────────────────────
  {
    name: "r8 RPC 임계 제거 — 무슨 질문이든 상한만큼 받아 100% 통과(환각 통로)",
    file: SERVER,
    from: "    p_max_distance: RAG_DOCUMENT_MAX_DISTANCE,",
    to: "",
  },
  {
    name: "r9 distance 전달 제거 — 임계 재보정 근거가 사라진다",
    file: SERVER,
    from: "    distance: typeof row.distance === \"number\" ? row.distance : undefined,",
    to: "",
  },
  {
    name: "r10 서빙 임계를 무관 분포까지 열기 — 근거 없는 질문이 rag 로 서빙된다",
    file: RETRIEVE,
    from: "export const RAG_DOCUMENT_MAX_DISTANCE = 0.42;",
    to: "export const RAG_DOCUMENT_MAX_DISTANCE = 0.60;",
  },

  // ── 배포 순서 방어 ───────────────────────────────────────────────────────
  {
    name: "r11 PGRST202 fail-close 제거 — migration 이전 배포에서 유저에게 오류가 나간다",
    file: SERVER,
    from: "    if (error.code === \"PGRST202\") return [];\n    throw error;",
    to: "    throw error;",
  },

  // ── 넓히되 뺏지 않는다 ───────────────────────────────────────────────────
  {
    // ⚠️ `void 0;` 같은 무해한 문장을 넣는 변이는 쓰지 않는다 — mutant 가 결함이 아니면
    //   그건 게이트 결함이 아니라 내 변이 결함이다(M90). 근거 0건에서도 종결시켜
    //   **실제로 기존 경로를 빼앗는** 형태로 주입한다.
    name: "r12 근거 없어도 공식 경로에서 종결 — 기존 종결(사전·구단·선수)을 전부 뺏는다",
    file: PIPELINE,
    from: "    if (official) return official;",
    to: "    if (official) return official;\n    return { status: 200, answer: UNCLEAR_ANSWER, source: \"unsure\", remaining };",
  },

  // ── 주제 이탈 선언 (Vercel RED 를 냈던 실재 회귀) ────────────────────────
  {
    name: "r14 주제 이탈 라우터 종결 제거 — `야구 얘기 그만하고 시를 써줘` 가 공식 RAG 를 탄다",
    file: PIPELINE,
    from: "  if (isTopicDismissal(question)) return \"blocked\";",
    to: "",
    smoke: "scripts/qa/baseball-qa-official-rag-smoke.ts",
  },
];

let red = 0;
const misses = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, "utf8");
  if (!original.includes(m.from)) {
    console.log(`MISS ${m.name} — 앵커 부재 (러너 고장)`);
    misses.push(m.name);
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to));
  let out = "";
  let exitFail = false;
  try {
    out = execSync(`npx tsx ${m.smoke ?? SMOKE}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 300000 });
  } catch (error) {
    exitFail = true;
    out = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
  writeFileSync(m.file, original);
  // RED = smoke 가 **의도한 FAIL 마커**를 찍고 죽었다. 컴파일 오류 같은 아무 nonzero exit 를
  // 검출로 세면 검증력이 0 이다(삼순 2026-08-10 B5).
  const intended = exitFail && (
    /genius-rag-first-routing-smoke FAIL:/.test(out)
    || /baseball QA official RAG: PASS=\d+ FAIL=[1-9]/.test(out)
    || /^FAIL /m.test(out)
  );
  if (intended) {
    console.log(`RED  ${m.name}`);
    red++;
  } else if (exitFail) {
    console.log(`MISS ${m.name} — 프로세스는 죽었지만 의도한 FAIL 마커가 아니다 (러너/컴파일 고장)`);
    misses.push(m.name);
  } else {
    console.log(`MISS ${m.name} — 결함이 통과했다 (검출력 0)`);
    misses.push(m.name);
  }
}

console.log(misses.length === 0 ? `\n✅ mutations: ${red}/${MUTATIONS.length} RED` : `\n❌ ${misses.length} 축 미검출`);
if (misses.length > 0) process.exitCode = 1;
