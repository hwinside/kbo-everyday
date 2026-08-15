#!/usr/bin/env node
// `qa:genius-thinking-bubble` 검출력 증명. 실제 배포 소스를 한 축씩 훼손하고
// 지정 assertion으로 RED인지 확인한 뒤 반드시 원복한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TARGETS = [
  "src/components/dm/GeniusTypingIndicator.tsx",
  "src/app/(main)/messages/[conversationId]/page.tsx",
  "src/lib/supabase/useDM.ts",
  "src/lib/baseball-qa/thinking-bubble.ts",
];
const originals = new Map(TARGETS.map((file) => [file, fs.readFileSync(file, "utf8")]));
const restore = () => {
  for (const [file, source] of originals) fs.writeFileSync(file, source);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const mutations = [
  {
    name: "M1 waiting 인디케이터 중복 복원",
    file: TARGETS[0],
    from: 'if (state !== "failed") return null;',
    to: 'if (state === "idle") return null;',
    expect: "중복 방지",
  },
  {
    name: "M2 page 말풍선 배선 상수 무력화",
    file: TARGETS[1],
    from: '{thinking.show && <GeniusThinkingBubble pending={thinking.pending} />}',
    to: '{false && <GeniusThinkingBubble pending={thinking.pending} />}',
    expect: "말풍선",
  },
  {
    name: "M3 hook route 전환 SSOT 우회 (actual DOM)",
    file: TARGETS[2],
    from: 'transitionGeniusThinkingMessageId(previousConversationId, conversationId, current)',
    to: 'null',
    script: "qa:genius-thinking-bubble:workflow",
    expect: "route 승격 뒤 Q1 thinking",
  },
  {
    name: "M4 draft→실제 route에서 marker 삭제 (actual DOM)",
    file: TARGETS[3],
    from: 'return previousConversationId === "" && nextConversationId !== "" ? current : null;',
    to: 'return null;',
    script: "qa:genius-thinking-bubble:workflow",
    expect: "route 승격 뒤 Q1 thinking",
  },
  {
    name: "M5 stale localStorage replyStates에서 marker 재유도 (actual DOM)",
    file: TARGETS[2],
    from: '  const previousConversationIdRef = useRef(conversationId);\n',
    to: `  const previousConversationIdRef = useRef(conversationId);
  useEffect(() => {
    const ids = Object.keys(geniusReplyStates).map(Number).filter(Number.isSafeInteger);
    if (ids.length > 0) setGeniusThinkingQuestionId((prev) => prev ?? Math.max(...ids));
  }, [geniusReplyStates]);
`,
    script: "qa:genius-thinking-bubble:workflow",
    expect: "stale outbox로 thinking이 되살아나면",
  },
  {
    name: "M6 답변 관측 때 marker clear (actual Realtime 답변 INSERT)",
    file: TARGETS[2],
    from: "        message.dedup_key === `baseball-genius:${messageId}`)) {\n        observedBaseballQaReplyIdsRef.current.add(messageId);\n      }",
    to: "        message.dedup_key === `baseball-genius:${messageId}`)) {\n        observedBaseballQaReplyIdsRef.current.add(messageId);\n        setGeniusThinkingQuestionId(null);\n      }",
    script: "qa:genius-thinking-bubble:workflow",
    expect: "답변 도착 후에도 Q1 생각중 말풍선",
  },
  {
    name: "M7 전송 marker를 observed guard 안으로 이동 (answer-before-outbox)",
    file: TARGETS[2],
    from: "          setGeniusThinkingQuestionId((prev) =>\n            markGeniusThinkingMessageId(result.message_id as number, prev));\n          if (!observedBaseballQaReplyIdsRef.current.has(result.message_id)) {",
    to: "          if (!observedBaseballQaReplyIdsRef.current.has(result.message_id)) {\n            setGeniusThinkingQuestionId((prev) =>\n              markGeniusThinkingMessageId(result.message_id as number, prev));",
    script: "qa:genius-thinking-bubble:workflow",
    expect: "전송 marker로 Q3 말풍선",
  },
];

let failures = 0;
for (const mutation of mutations) {
  const source = originals.get(mutation.file);
  const count = source.split(mutation.from).length - 1;
  if (count !== 1) {
    console.error(`FAIL ${mutation.name}: anchor=${count} (1 필요)`);
    failures += 1;
    continue;
  }
  fs.writeFileSync(mutation.file, source.replace(mutation.from, mutation.to));
  const run = spawnSync("npm", ["run", "-s", mutation.script ?? "qa:genius-thinking-bubble"], { encoding: "utf8" });
  restore();
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.status !== 0 && output.includes(mutation.expect)) {
    console.log(`PASS 결함주입 RED: ${mutation.name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${mutation.name}: status=${run.status} evidence=${output.includes(mutation.expect)}`);
    console.error(output.split("\n").filter((line) => line.includes("❌") || line.includes("FAIL")).slice(0, 8).join("\n"));
  }
}
restore();
if (failures > 0) {
  console.error(`FAIL thinking-bubble mutations: ${failures}건`);
  process.exit(1);
}
console.log(`PASS thinking-bubble mutations: ${mutations.length}/${mutations.length} RED`);
