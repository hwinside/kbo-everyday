#!/usr/bin/env node
/**
 * `qa:genius-draft-year` **검출력 증명** — 결함을 주입해 RED 가 나는지 본다.
 *
 * ⚠️ 왜 필요한가: 게이트가 GREEN 이라는 것은 "결함이 없다" 가 아니라 "이 게이트가
 *   본 축에 결함이 없다" 일 뿐이다. 이 PR 에서만 게이트가 못 잡은 결함이 두 번 나왔다
 *   (`몇 라운드?` 에 라운드 없이 PASS / 구단 불일치 오답 PASS — 삼순 2026-08-09 P0-3).
 *   그래서 각 방어축마다 변이를 만들어 **기대한 문구로** RED 가 나는지 확인한다.
 *   nonzero exit 만으로는 부족하다 — 컴파일 오류로 죽은 것과 구분되지 않는다.
 *
 * 실행: npm run qa:genius-draft-year:mutations
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const TARGETS = {
  draft: "src/lib/baseball-qa/roster/draft.ts",
  pipeline: "src/lib/baseball-qa/pipeline.ts",
  context: "src/lib/baseball-qa/context.ts",
  backfill: "scripts/backfill-roster-draft.mjs",
  reconcile: "scripts/reconcile-roster-from-stats.mjs",
  workflow: ".github/workflows/update-roster-stats.yml",
  draftjson: "src/lib/constants/players-draft.json",
};

const MUTATIONS = [
  {
    name: "D-A 미래 연도 가드 제거 (2055년 입단이 확정 문장으로 나간다)",
    file: "draft",
    from: `  if (!isPlausibleDraftYear(year, now)) return null;`,
    to: `  if (false) return null;`,
    expect: "미래 연도를 받았다",
  },
  {
    name: "D-B 구단 불일치 경고 제거 (키움 질의에 LG 입단만 답한다)",
    file: "draft",
    from: `  if (askedTeam && !teamMatches(askedTeam, draft.team)) {`,
    to: `  if (false) {`,
    expect: "구단 불일치 안내가 없다",
  },
  {
    name: "D-C 순번 렌더 제거 (`몇 라운드?` 에 연도만 답한다)",
    file: "draft",
    from: `  const head = wantsDetail && detail.length > 0`,
    to: `  const head = false && detail.length > 0`,
    expect: "라운드를 답하지 않았다",
  },
  {
    name: "D-D 순번 질문 판정 제거",
    file: "draft",
    from: `  return /라운드|순위|순번|몇번째|지명방식|몇차/.test(compact);`,
    to: `  return false;`,
    expect: "라운드를 답하지 않았다",
  },
  {
    name: "D-E 미수집/미등록 구분 제거 (수집 누락을 KBO 탓으로 돌린다)",
    file: "draft",
    from: `  return raw === undefined || raw === null ? "not_collected" : "not_registered";`,
    to: `  return "not_registered";`,
    expect: "공식 기록에 등록돼 있지 않아",
  },
  {
    // ⚠️ 종전 D-F(`if (team.length === 0) return null;` 제거)는 **동등변이**였다.
    //   정규식이 구단명을 필수로 잡아 그 분기가 도달 불가였기 때문이다(실측 GREEN).
    //   그래서 죽은 가드를 지우고, 실제 방어축인 **정규식**을 태우도록 바꿨다.
    name: "D-F 부분 성공 허용 (구단 캡처를 옵셔널로 → 연도만으로 답한다)",
    file: "draft",
    // ⚠️ 템플릿 리터럴에서 `\d` 는 **`d` 로 붕괴**한다(JS 미지정 이스케이프). 그래서
    //   앵커가 안 맞아 "적용 안 됐는데 GREEN" 이 났다 — runner 가 그걸 고장으로 잡았다.
    //   정규식 리터럴을 문자열에 넣을 때는 백슬래시를 두 번 쓴다.
    from: `  const matched = /^(\\d{2})\\s+([A-Za-z가-힣]+)\\s*(.*)$/.exec(value);`,
    to: `  const matched = /^(\\d{2})\\s*([A-Za-z가-힣]*)\\s*(.*)$/.exec(value);`,
    expect: "null 이어야 한다",
  },
  {
    name: "D-G 입단 질문 판정 제거 (공식 경로에 도달하지 못한다)",
    file: "draft",
    from: `  if (/입단|드래프트/.test(compact)) return true;`,
    to: `  if (false) return true;`,
    expect: "source=",
  },
  {
    name: "D-G2 순위류 단독 차단 제거 (`지금 몇 순위야?` 가 입단 경로로 새기 시작한다)",
    file: "draft",
    from: `  return /지명/.test(withoutDh) && /라운드|순위|순번|몇번째|방식/.test(withoutDh);`,
    to: `  return /지명|순위|라운드/.test(compact);`,
    expect: "순위류 단독인데 드래프트로 오판",
  },
  {
    name: "D-H 입단 후속 맥락 조회 제거 (2턴이 끊긴다)",
    file: "pipeline",
    from: `  const draftFollowup = isDraftQuestion(question)
    && !mentionsAnyRosterName(question, players)
    && isDraftFollowupGrammar(question);`,
    to: `  const draftFollowup = false;`,
    // 상시 로드 구조(2026-08-10)에서 조회는 항상 1회다 — 결함의 증상은 "조회 없음"이
    // 아니라 **재결속 실패로 unsure 로 떨어지는 것**이다. 기대 문구를 실제 증상으로 맞춘다.
    expect: "결속돼 2011년 :: source=unsure",
  },
  {
    name: "D-K draft allowlist 확대 (team_rag·news_rag 까지 열린다)",
    file: "context",
    from: `export const DRAFT_CONTEXT_SOURCE_ALLOWLIST = [
  "dictionary", "cache", "llm", "rag", "kbo_structured",
] as const;`,
    to: `export const DRAFT_CONTEXT_SOURCE_ALLOWLIST = [
  "dictionary", "cache", "llm", "rag", "kbo_structured", "team_rag", "news_rag",
] as const;`,
    expect: "부적격 소스로 답했다",
  },
  {
    name: "D-L 되묻기 문법 축 제거 (무지칭 일반 질문이 직전 선수로 샌다)",
    file: "pipeline",
    from: `    && isDraftFollowupGrammar(question);`,
    to: `    && true;`,
    expect: "직전 선수로 샜다",
  },
  {
    name: "D-M 명시 이름 차단 제거 (복수·동명이인이 직전 선수로 샌다)",
    file: "pipeline",
    from: `    && !mentionsAnyRosterName(question, players)`,
    to: `    && true`,
    expect: "동명이인이 직전 선수로 샜다",
  },
  {
    name: "D-N draft 전용 selector 회귀 (global allowlist 로 rag 후속이 끊긴다)",
    file: "pipeline",
    from: `      draftContext = draftFollowup ? selectDraftContextTurn(row) : null;`,
    to: `      draftContext = draftFollowup ? selectContextTurn(row) : null;`,
    expect: "source=",
  },
  {
    name: "D-O markup drift 를 공식 빈값으로 확정 (?? \"\" 회귀)",
    file: "backfill",
    from: `    return draft === null ? { kind: "markup_drift" } : { kind: "ok", draft };`,
    to: `    return { kind: "ok", draft: draft ?? "" };`,
    expect: "backfill markup drift fail-close 가 없다",
  },
  {
    name: "D-P exact key-set — 키 1개 소실도 RED (90% 게이트와의 차이)",
    file: "draftjson",
    from: `  "61101": "11 LG 1라운드 2순위",`,
    to: ``,
    expect: "draft 미수집 키",
  },
  {
    name: "D-Q reconcile 신규 온보딩 draft 기록 제거",
    file: "reconcile",
    from: `      draftAdditions[String(m.kboId)] = detail.draft.trim();`,
    to: `      ;`,
    expect: "reconcile 신규 온보딩 draft 기록이 없다",
  },
  {
    name: "D-R workflow backfill 스텝 제거 (신규 선수 draft 가 채워지지 않는다)",
    file: "workflow",
    from: `        run: node scripts/backfill-roster-draft.mjs`,
    to: `        run: echo skip`,
    expect: "workflow 에 backfill 스텝이 없다",
  },
  {
    name: "D-I 후속 선수 결속 제거 (직전 턴이 있어도 못 답한다)",
    file: "pipeline",
    from: `      draftContextCandidate)`,
    to: `      null)`,
    expect: "source=",
  },
  {
    name: "D-J 직전 턴의 답변에서 선수를 푼다 (엉뚱한 선수로 결속)",
    file: "pipeline",
    from: `    ? resolveNamedPlayerCandidate(draftContext.question, players)`,
    to: `    ? resolveNamedPlayerCandidate(draftContext.answer, players)`,
    expect: "엉뚱한 선수로 결속됐다",
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

console.log("=== genius-draft-year mutation runner ===");
for (const [key, file] of Object.entries(TARGETS)) copyFileSync(file, backups[key]);

let red = 0;
const missed = [];
try {
  for (const mutation of MUTATIONS) {
    restoreAll();
    const file = TARGETS[mutation.file];
    const original = readFileSync(file, "utf8");
    if (!original.includes(mutation.from)) {
      // ⚠️ 앵커가 사라지면 변이가 **적용되지 않은 채** GREEN 이 난다. 그건 검출 성공이
      //   아니라 runner 고장이다 — 즉시 실패로 본다.
      console.log(`❌ ${mutation.name} → 앵커 없음 (runner 고장)`);
      missed.push(mutation.name);
      continue;
    }
    writeFileSync(file, original.replace(mutation.from, mutation.to));
    let output = "";
    try {
      output = execFileSync("npx", ["tsx", "scripts/qa/genius-draft-year-smoke.ts"], {
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
  for (const name of missed) console.error(`  - ${name}`);
  process.exit(1);
}
console.log("✅ mutation: 전 축 RED (게이트 검출력 확인)");
