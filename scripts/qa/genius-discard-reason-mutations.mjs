#!/usr/bin/env node
/**
 * `qa:genius-discard-reason` **검출력 증명** — 실제 배포 코드에 결함을 주입해 RED 가 나는지 본다.
 *
 * ⚠️ 왜 필요한가 (삼순 2026-08-16 1차 NO-GO ③): 종전 `--selftest` 는 결함주입이 아니라
 *   "정상 코드에서 단언이 성립하는가" 를 다시 확인할 뿐이었다. 그건 검출력 증명이 아니다.
 *   게이트가 GREEN 이라는 것은 "결함이 없다" 가 아니라 "이 게이트가 본 축에 결함이 없다" 일 뿐이므로,
 *   각 방어축마다 변이를 만들어 **기대한 문구로** RED 가 나는지 확인한다.
 *   nonzero exit 만으로는 부족하다 — 컴파일 오류로 죽은 것과 구분되지 않는다.
 *
 * 실행: npm run qa:genius-discard-reason:mutations
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const TARGETS = {
  pipeline: "src/lib/baseball-qa/pipeline.ts",
  retrieve: "src/lib/baseball-qa/rag/retrieve.ts",
  logrow: "src/lib/baseball-qa/log-row.ts",
  migration: "supabase/migrations/20260816140000_genius_question_logs_rag_discard_reason.sql",
};

const MUTATIONS = [
  {
    name: "M1 폐기 사유를 로그에 안 보낸다 (계측 자체가 죽는다)",
    file: "pipeline",
    from: `    ragDiscardReason: discardReasonOf(validated),
    ragDiscardNumericCount: discardNumericCountOf(validated),`,
    to: `    ragDiscardReason: null,
    ragDiscardNumericCount: null,`,
    expect: "숫자 폐기 사유가 로그에 없다",
  },
  {
    name: "M2 경로 라벨을 안 보낸다 (어느 RAG 에서 버렸는지 사라진다 — 삼순 ①)",
    file: "pipeline",
    from: `    ragAttemptPath: attemptPath,`,
    to: `    ragAttemptPath: null as unknown as RagAttemptPath,`,
    expect: "경로가 실리지 않았다",
  },
  {
    name: "M3 서빙 행에는 경로를 안 남긴다 (분자만 있고 분모가 없다 — 삼순 ①)",
    file: "pipeline",
    // ⚠️ 앵커는 **서빙 로그 블록 그 자체**를 잡는다. 종전에는 envelope 쪽 문면
    //   (`ragAttemptPath: "team",`)에 걸었는데, 서빙 envelope 를 `ragObservation()` 으로
    //   통일하면서 그 문자열이 사라져 앵커가 깨졌다(runner 고장으로 검출됨).
    //   조립기를 쓰는 지금은 로그 호출부에서 관측을 빼는 것이 이 결함의 정확한 형태다.
    from: `  await deps.log({
    userId, question, questionNorm, matchPath: "team_rag", answer,
    inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
    toneCompliant: validated.toneCompliant,
    ...ragObservation("team", question, validated),
  });`,
    to: `  await deps.log({
    userId, question, questionNorm, matchPath: "team_rag", answer,
    inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
    toneCompliant: validated.toneCompliant,
  });`,
    expect: "서빙 행에 경로가 없다",
  },
  {
    name: "M4 envelope 에 관측을 안 싣는다 (crash replay 에서 유실 — 삼순 ②)",
    file: "pipeline",
    from: `    ...(isRagAttemptPath(final.ragAttemptPath) ? { ragAttemptPath: final.ragAttemptPath } : {}),
    ...(isRagDiscardReason(final.ragDiscardReason) ? { ragDiscardReason: final.ragDiscardReason } : {}),`,
    to: `    ...({}),
    ...({}),`,
    expect: "envelope 에 폐기 사유가 없다",
  },
  {
    name: "M5 재생이 관측을 다시 null 로 쓴다 (삼순 ② 정확한 증상)",
    file: "pipeline",
    from: `    ragAttemptPath: storedFinal.ragAttemptPath ?? null,
    ragQuestionNumericCount: storedFinal.ragQuestionNumericCount ?? null,
    ragDiscardReason: storedFinal.ragDiscardReason ?? null,`,
    to: `    ragAttemptPath: null,
    ragQuestionNumericCount: null,
    ragDiscardReason: null,`,
    expect: "재생에서 폐기 사유가 유실됐다",
  },
  {
    name: "M6 오염 envelope 를 그대로 통과시킨다 (배포 후 23514 로 로그가 죽는다)",
    file: "pipeline",
    from: `    ...(isRagDiscardReason(final.ragDiscardReason) ? { ragDiscardReason: final.ragDiscardReason } : {}),`,
    to: `    ...(typeof final.ragDiscardReason === "string" ? { ragDiscardReason: final.ragDiscardReason as RagDiscardReason } : {}),`,
    expect: "폐쇄집합 밖 사유가 살아남았다",
  },
  {
    name: "M7 log-row 가 사유 칸을 빠뜨린다 (production 은 영원히 null — 8/13 단절 축)",
    file: "logrow",
    from: `    rag_discard_reason: entry.ragDiscardReason ?? null,`,
    to: ``,
    expect: "INSERT 행에 사유가 없다",
  },
  {
    name: "M8 log-row 가 경로 칸을 빠뜨린다",
    file: "logrow",
    from: `    rag_attempt_path: entry.ragAttemptPath ?? null,`,
    to: ``,
    expect: "INSERT 행에 경로가 없다",
  },
  {
    name: "M9 숫자 개수를 안 센다 (분포를 못 봐 B/A 우선순위를 못 가른다)",
    file: "retrieve",
    from: `        numericCount: numericTokenCount(answer),
      };
    }`,
    to: `      };
    }`,
    // ⚠️ expect 는 **다른 변이와 겹치지 않아야** 한다. 종전 "숫자 개수가 실리지 않았다"(③ 문구)로
    //   잡았더니 ② 가 먼저 죽어 그 문구가 출력되지 않아 GREEN 으로 오판됐다 — 게이트는
    //   잡았는데 runner 가 못 읽은 것이다. 실제 증상(undefined)으로 좁힌다.
    expect: "숫자 개수가 undefined",
  },
  {
    name: "M10 개수 대신 값을 남긴다 (익명집계 조건 위반 — 삼순 조건)",
    file: "retrieve",
    from: `export function numericTokenCount(text: string): number {
  return (text.match(/\\p{N}+(?:[.]\\p{N}+)?/gu) ?? []).length;
}`,
    to: `export function numericTokenCount(text: string): number {
  return Number((text.match(/\\p{N}+(?:[.]\\p{N}+)?/gu) ?? ["0"])[0]);
}`,
    expect: "숫자 개수가 1990",
  },
  {
    name: "M16 질문 숫자 개수를 안 보낸다 (질문 기원 여부조차 못 가른다 — 삼순 2차 ①)",
    file: "pipeline",
    from: `    ragQuestionNumericCount: numericTokenCount(question),`,
    to: `    ragQuestionNumericCount: 0,`,
    expect: "질문 숫자 개수가 2 가 아니다",
  },
  {
    name: "M17 log-row 가 질문 개수 칸을 빠뜨린다 (production 은 영원히 null)",
    file: "logrow",
    from: `    rag_question_numeric_count: entry.ragQuestionNumericCount ?? null,`,
    to: ``,
    expect: "INSERT 행에 질문 숫자 개수가 없다",
  },
  {
    name: "M18 envelope 가 질문 개수를 안 싣는다 (crash replay 에서 유실)",
    file: "pipeline",
    from: `    ...(isNonNegativeInteger(final.ragQuestionNumericCount)
      ? { ragQuestionNumericCount: final.ragQuestionNumericCount } : {}),`,
    to: `    ...({}),`,
    expect: "envelope 에 질문 숫자 개수가 없다",
  },
  {
    name: "M19 migration 에 질문 개수 컬럼이 없다",
    file: "migration",
    from: `  add column if not exists rag_question_numeric_count integer;`,
    to: `  add column if not exists rag_question_numeric_count_TYPO integer;`,
    expect: "rag_question_numeric_count integer 컬럼을 추가하지 않는다",
  },
  {
    name: "M20 official GENERAL 출구가 경로 라벨을 안 남긴다 (공식 실패율 분모 소실 — 삼순 2차 ②)",
    file: "pipeline",
    // ⚠️ 앵커는 `ragObservation` 의 **현재 시그니처**를 따라간다 (2026-08-27: 거리 관측
    //   인자 `evidence` 추가). 게이트 핀이 내 시그니처 변경을 잡으면 그건 게이트가 옳은
    //   것이므로 같은 PR 에서 동기화한다 — 앵커를 느슨하게 만들면 검출력이 떨어진다.
    from: `      toneCompliant: validated.toneCompliant,
      ...ragObservation("official", question, validated, evidence),
    });
    return { status: 200, answer: validated.answer, source: "llm", remaining };`,
    to: `      toneCompliant: validated.toneCompliant,
    });
    return { status: 200, answer: validated.answer, source: "llm", remaining };`,
    expect: "GENERAL 서빙 행에 경로가 없다",
  },
  {
    name: "M11 migration CHECK 에서 사유 하나를 뺀다 (배포 후 23514)",
    file: "migration",
    from: `      'numeric_claim_ungrounded',`,
    to: ``,
    expect: "폐기 사유 CHECK 가 어긋난다",
  },
  {
    name: "M12 migration CHECK 에서 경로 하나를 뺀다",
    file: "migration",
    from: `    or rag_attempt_path in ('player', 'official', 'team', 'news')`,
    to: `    or rag_attempt_path in ('player', 'official', 'team')`,
    expect: "경로 집합과 migration CHECK 가 어긋난다",
  },
  {
    name: "M13 CHECK 가 null 을 막는다 (폐기 없는 행 전부 INSERT 실패 = 서비스 정지)",
    file: "migration",
    from: `    rag_attempt_path is null
    or `,
    to: `    `,
    expect: "rag_attempt_path is null 을 허용하지 않는다",
  },
  {
    name: "M14 숫자 개수 컬럼을 안 만든다",
    file: "migration",
    from: `  add column if not exists rag_discard_numeric_count integer;`,
    to: `  add column if not exists rag_discard_numeric_count_TYPO integer;`,
    expect: "rag_discard_numeric_count integer 컬럼을 추가하지 않는다",
  },
  {
    // ⚠️ 첫 시도는 **동등변이**였다: `ragObservation` 에서 `validated.answer` 를 노출하려 했는데
    //   `ValidatedRagAnswer` 의 insufficient 분기에는 answer 필드가 **아예 없다** — 폐기 본문을
    //   그 자리에서 얻을 방법이 구조적으로 없어 아무것도 새지 않았다(실측 GREEN).
    //   실제로 원문이 샐 수 있는 곳은 **모델 원응답(`llm.text`)** 이다. 그걸 로그에 싣는다.
    name: "M15 모델 원응답을 로그에 싣는다 (원문 비저장 계약 위반 — 삼순 익명집계 조건)",
    file: "pipeline",
    from: `    await deps.log({
      userId, question, questionNorm, matchPath, answer,
      inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
      ...ragObservation("team", question, validated),
    });`,
    to: `    await deps.log({
      userId, question, questionNorm, matchPath, answer,
      inputTokens: llm.inputTokens, outputTokens: llm.outputTokens,
      ...ragObservation("team", question, validated),
      ...({ rawLlmText: llm.text } as Record<string, never>),
    });`,
    expect: "로그로 샜다",
  },
];

const backups = Object.fromEntries(
  Object.entries(TARGETS).map(([key, file]) => [key, `${file}.mut-backup`]),
);

function restoreAll() {
  for (const [key, file] of Object.entries(TARGETS)) {
    try { copyFileSync(backups[key], file); } catch { /* 없으면 건너뛴다 */ }
  }
}

console.log("=== genius-discard-reason mutation runner ===");
for (const [key, file] of Object.entries(TARGETS)) copyFileSync(file, backups[key]);

let red = 0;
const missed = [];
try {
  for (const mutation of MUTATIONS) {
    if (mutation.equivalent) continue;
    restoreAll();
    const file = TARGETS[mutation.file];
    const original = readFileSync(file, "utf8");
    if (!original.includes(mutation.from)) {
      // ⚠️ 앵커가 사라지면 변이가 **적용되지 않은 채** GREEN 이 난다. 그건 검출 성공이
      //   아니라 runner 고장이다 — 즉시 실패로 본다 (2026-08-15 앵커 MISS 교훈).
      console.log(`❌ ${mutation.name} → 앵커 없음 (runner 고장)`);
      missed.push(mutation.name);
      continue;
    }
    writeFileSync(file, original.replace(mutation.from, mutation.to));
    let output = "";
    try {
      output = execFileSync("npx", ["tsx", "scripts/qa/genius-discard-reason-observability.ts"], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    if (output.includes(mutation.expect)) {
      red += 1;
      console.log(`✅ ${mutation.name} → RED (\`${mutation.expect}\`)`);
    } else {
      missed.push(mutation.name);
      console.log(`❌ ${mutation.name} → GREEN (게이트가 이 결함을 못 잡는다)`);
    }
  }
} finally {
  restoreAll();
  for (const backup of Object.values(backups)) {
    try { unlinkSync(backup); } catch { /* 이미 없으면 통과 */ }
  }
}

console.log("----------------------------------------");
console.log(`RED ${red} · 검출실패 ${missed.length}`);
if (missed.length > 0) {
  console.error(`❌ mutation: 검출 실패 ${missed.length}건 — 게이트가 그 축을 보지 못한다`);
  for (const name of missed) console.error(`   · ${name}`);
  process.exit(1);
}
console.log(`✅ genius-discard-reason mutation: ${red}축 전부 RED`);
