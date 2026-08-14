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
    name: "M3 hook route 전환 SSOT 우회",
    file: TARGETS[2],
    from: 'transitionGeniusThinkingMessageId(previousConversationId, conversationId, current)',
    to: 'null',
    expect: "실제 conversation 전환 함수",
  },
  {
    name: "M4 draft→실제 route에서 marker 삭제",
    file: TARGETS[3],
    from: 'return previousConversationId === "" && nextConversationId !== "" ? current : null;',
    to: 'return null;',
    expect: "draft→실제 대화 route 승격",
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
  const run = spawnSync("npm", ["run", "-s", "qa:genius-thinking-bubble"], { encoding: "utf8" });
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
console.log("PASS thinking-bubble mutations: 4/4 RED");
