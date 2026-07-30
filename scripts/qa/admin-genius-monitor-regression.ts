import assert from "node:assert/strict";
import {
  createLatestRequestGate,
  mapQuestionJobsByMessageId,
  takeDetailPage,
  type DetailCursor,
} from "../../src/lib/admin/baseball-genius-monitor";

type Row = { id: number; created_at: string };

function collectAll(total: number) {
  const rows = Array.from({ length: total }, (_, index) => ({
    id: total - index,
    created_at: new Date(Date.UTC(2026, 6, 30, 0, 0, total - index)).toISOString(),
  }));
  const collected: Row[] = [];
  let cursor: DetailCursor | null = null;
  do {
    const remaining = cursor
      ? rows.filter((row) =>
          row.created_at < cursor!.messageAt ||
          (row.created_at === cursor!.messageAt && row.id < Number(cursor!.messageId)))
      : rows;
    const { page, nextCursor } = takeDetailPage(remaining.slice(0, 201), 200);
    collected.push(...page);
    cursor = nextCursor;
  } while (cursor);
  return collected;
}

assert.equal(collectAll(201).length, 201, "201건은 2페이지로 전부 열람돼야 한다");
assert.equal(collectAll(401).length, 401, "401건은 3페이지로 전부 열람돼야 한다");

const gate = createLatestRequestGate();
const requestA = gate.begin();
const requestB = gate.begin();
assert.equal(gate.isCurrent(requestA), false, "늦게 끝난 A 요청은 commit되면 안 된다");
assert.equal(gate.isCurrent(requestB), true, "최신 B 요청만 commit돼야 한다");
gate.invalidate();
assert.equal(gate.isCurrent(requestB), false, "목록 복귀 시 진행 중 상세 요청은 무효화돼야 한다");

const jobMap = mapQuestionJobsByMessageId([
  { message_id: 101, source: "dictionary", llm_input_tokens: null, llm_output_tokens: null },
  { message_id: 102, source: "llm", llm_input_tokens: 50, llm_output_tokens: 10 },
]);
assert.equal(jobMap.get("101")?.source, "dictionary");
assert.equal(jobMap.get("102")?.source, "llm");
assert.equal(jobMap.get("999"), undefined, "동일 문구여도 messageId 없는 job은 붙으면 안 된다");

console.log("[admin-genius-monitor-regression] PASS — keyset 201/401, latest-only, exact messageId");
