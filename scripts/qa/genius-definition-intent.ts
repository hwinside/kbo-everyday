/** Reviewer execution only. Paired real selectors/renderers and in-memory answerQuestion.
 * npx tsx scripts/qa/genius-definition-intent.ts --base-root=... --out=...
 * No DB/auth/DM/cache writes. Downstream factual answer quality requires separate QA.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { GameConversationInput } from "../../src/lib/baseball-qa/game-conversation";
import type { QaDeps } from "../../src/lib/baseball-qa/pipeline";
const cases = [
  { id: "observed-3535032", q: "가을야구 알려주세요", need: "none" },
  { id: "open-topic-postseason", q: "포스트시즌 알려줘", need: "none" },
  { id: "open-topic-series", q: "한국시리즈 설명해줘", need: "none" },
  { id: "open-topic-playoff", q: "플레이오프에 대해 알려줘", need: "none" },
  { id: "definition", q: "가을야구가 뭐야?", need: "none" },
  { id: "postseason-meaning", q: "포스트시즌 뜻 알려줘", need: "none" },
  { id: "series-meaning", q: "한국시리즈가 뭔가요?", need: "none" },
  { id: "structure", q: "포스트시즌은 어떤 방식으로 진행돼?", need: "none" },
  { id: "wildcard", q: "와일드카드 제도 설명해줘", need: "none" },
  { id: "comparison", q: "정규시즌 우승과 한국시리즈 우승은 어떻게 달라?", need: "none" },
  { id: "context-definition-reset", q: "일정 말고 포스트시즌이라는 말의 뜻을 알려줘", previous: "올해 포스트시즌 대진 알려줘", need: "none" },
  { id: "balk-control", q: "보크가 뭐야?", need: "none" },
  { id: "new-3573452", q: "야구 투수 동작이나 여러 상황과 관련된 용어들과 뜻 알려주세요.", need: "none" },
  { id: "bracket", q: "올해 포스트시즌 대진 알려줘", need: "postseason_schedule" },
  { id: "match-schedule", q: "올해 한국시리즈 1차전 일정 알려줘", need: "postseason_schedule" },
  { id: "match-result", q: "올해 한국시리즈 1차전 경기 결과 알려줘", need: "postseason_schedule" },
  { id: "explicit-current-reset", q: "뜻 말고 올해 포스트시즌 대진 알려줘", previous: "포스트시즌이 뭐야?", need: "postseason_schedule" },
  { id: "qualification", q: "LG 가을야구 진출 가능해?", need: "qualification" },
  { id: "standing", q: "키움 지금 몇 위야?", need: "team_standing" },
  { id: "event-date", q: "가을야구는 언제 시작해?", need: "event_date" },
  { id: "occurrence", q: "엘지가 구자욱 영입할 확률", need: "none" },
] as const;
type Case = { id: string; q: string; previous?: string; need: string };
const arg = (name: string) => process.argv.find(x => x.startsWith(`--${name}=`))?.slice(name.length + 3);
async function main() {
  const base = arg("base-root"), out = arg("out");
  if (!base || !out) throw new Error("--base-root and --out required; live calls, reviewer only");
  const rows: Record<string, unknown>[] = [];
  let headFailures = 0;
  for (const [variant, root] of [["base", base], ["head", path.resolve(import.meta.dirname, "../..")]]) {
    const server = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/server.ts")).href);
    const game = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/game-conversation.ts")).href);
    const pipeline = await import(pathToFileURL(path.join(root, "src/lib/baseball-qa/pipeline.ts")).href);
    for (const c of cases as readonly Case[]) for (let repeat = 0; repeat < 3; repeat++) {
      const row: Record<string, unknown> = { variant, id: c.id, repeat, question: c.q, previous: c.previous ?? null };
      try {
        const now = Date.parse("2026-11-10T02:30:00Z");
        const input: GameConversationInput = {
          question: c.q, context: c.previous ? { question: c.previous, answer: "앞선 답변은 사실 근거가 아닙니다." } : undefined,
          date: "2026-11-10", nowMs: now, favoriteTeam: null, games: [],
          teamNames: { question: pipeline.mentionedTeamCanonicals(c.q), context_question: pipeline.mentionedTeamCanonicals(c.previous ?? ""), profile: [] },
          teamCandidates: pipeline.conversationTeamCandidates(c.q, c.previous),
          appFacts: { tomorrow: { date: "2026-11-11", games: [] }, standings: { season: 2026, fetchedAt: new Date(now).toISOString(),
            rows: [{ teamId: 10, teamName: "키움", games: 144, wins: 50, losses: 90, draws: 4, ranking: 10, winRate: .357, gamesBehind: 30 }] } },
        };
        const raw = await server.callGameConversation(input);
        const plan = JSON.parse(raw.text);
        const rendered = game.renderGameConversation(raw.text, input, { isBare: pipeline.isBareTeamName });
        Object.assign(row, { plan, rendered });
        if (["none", "event_date"].includes(c.need)) {
          // event_date is intentionally unsupported by the renderer regardless
          // of action label; do not grade the base-identical label as this fix.
          if (c.need === "none") assert.equal(plan.action, "other");
          assert.equal(plan.appRequest?.informationNeed, c.need);
          assert.equal(rendered, null, "concept explanation must not render current bracket hold");
        } else {
          assert.equal(plan.action, "app_facts");
          assert.equal(plan.appRequest?.informationNeed, c.need);
          assert.ok(rendered, "supported fact request must retain its renderer");
        }
        // Real orchestration, same sampled plan; downstream model is deliberately an
        // abstention stub. This checks routing, NOT live RAG quality or user UI.
        const deps: QaDeps = {
          loadGlossary: async () => [], loadPlayers: async () => [], getCache: async () => null,
          setCache: async () => {}, reserveDaily: async () => ({ allowed: true, remaining: 9 }),
          log: async () => {}, now: () => now,
          loadGameConversation: async () => ({ favoriteTeam: null, games: input.games, appFacts: input.appFacts }),
          callGameConversation: async () => raw,
          callLlm: async () => ({ text: '{"status":"UNSURE"}', inputTokens: 0, outputTokens: 0 }),
        };
        const final = await pipeline.answerQuestion("qa-definition-memory-only", c.q, deps);
        row.final = final;
        if (["none", "event_date"].includes(c.need)) {
          assert.doesNotMatch(final.answer, /최신 포스트시즌 대진|미확정 대진/);
        }
        row.pass = true;
      } catch (error) {
        row.pass = false; row.error = error instanceof Error ? error.message : String(error);
        if (variant === "head") headFailures++;
      }
      rows.push(row); fs.writeFileSync(out, JSON.stringify(rows, null, 2));
    }
  }
  console.log(JSON.stringify({ rows: rows.length, headFailures }));
  assert.equal(headFailures, 0, "preserve all failures; independent review required");
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
