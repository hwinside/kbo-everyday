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
    // ⚠️ 이 앵커는 page 의 JSX 모양을 그대로 복사한다 — prop 이 늘어 멀티라인이 되면
    // 앵커가 조용히 MISS 되고(anchor=0) mutation 이 검증력 없이 FAIL 한다.
    // 2026-08-15 showMascot 추가 때 실제로 그러져 Vercel 빌드가 깨졌다.
    from: `{thinking.show && (
                <GeniusThinkingBubble`,
    to: `{false && (
                <GeniusThinkingBubble`,
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
    // 🔴 원복(2026-08-17)으로 M6·M7 의 **의미가 바뀌었다.**
    //    옛 M6 = "답변 관측 때 marker 를 지운다", 옛 M7 = "전송 marker 를 observed guard 안으로".
    //    둘 다 **잔존 계약**을 깨는 결함이었는데, 지금은 답변이 오면 어차피 사라지므로
    //    두 훼손이 화면에 아무 차이를 만들지 못한다 = **관측 불가**다. 관측 불가한 축을
    //    억지로 RED 로 만들려 하면 게이트가 거짓말을 하게 되므로, 지금 계약을 지키는
    //    축으로 **교체**한다. 새 M6·M7 은 "잔존이 되살아나는" 정확히 그 회귀를 잡는다.
    name: "M6 show 를 pending 에서 분리 (잔존 부활 시도 — SSOT)",
    file: TARGETS[3],
    from: "  return { show: pending, pending };",
    to: "  return { show: true, pending };",
    expect: "답변 도착 후 말풍선이 사라진다",
  },
  {
    name: "M7 컴포넌트가 pending=false 에도 말풍선을 그린다 (잔존 부활 시도 — 렌더)",
    file: TARGETS[0],
    from: "  if (!pending) return null;",
    to: "  if (false) return null;",
    expect: "답변 도착 후 말풍선이 사라진다",
  },
  {
    // 전송 트리거가 outbox 파생으로 되돌아가는 회귀는 **여전히 실재하는 결함**이라 남긴다.
    // (원복과 무관한 축 — 답변 선도착 시 marker 자체가 안 찍히면 대기 중에도 안 보인다.)
    name: "M8 전송 marker를 observed guard 안으로 이동 (outbox 파생 회귀)",
    file: TARGETS[2],
    from: "          setGeniusThinkingQuestionId((prev) =>\n            markGeniusThinkingMessageId(result.message_id as number, prev));\n          if (!observedBaseballQaReplyIdsRef.current.has(result.message_id)) {",
    to: "          if (!observedBaseballQaReplyIdsRef.current.has(result.message_id)) {\n            setGeniusThinkingQuestionId((prev) =>\n              markGeniusThinkingMessageId(result.message_id as number, prev));",
    expect: "마커는 전송 시점에 찍힌다",
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
  // 빌드 컨테이너 OOM(SIGKILL, status 137)은 판정 불능이지 GREEN이 아니다 — GREEN은 반드시
  // status 0 으로만 나타난다. 자식 힙을 제한해 OOM 자체를 줄이고, 그래도 죽으면 1회 재시도한다
  // (Vercel 2026-08-15 M1 status=137 실측 — 로컬 7/7 RED 와 동일 소스).
  const runOnce = () => spawnSync("npm", ["run", "-s", mutation.script ?? "qa:genius-thinking-bubble"], {
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=2048" },
  });
  let run = runOnce();
  if (run.status === 137 || run.signal === "SIGKILL") {
    console.warn(`WARN ${mutation.name}: SIGKILL(OOM 추정) — 1회 재시도`);
    run = runOnce();
  }
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
