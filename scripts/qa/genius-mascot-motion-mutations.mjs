#!/usr/bin/env node
// `qa:genius-mascot-motion` 검출력 증명. 실제 배포 소스를 한 축씩 훼손하고
// 지정 assertion으로 RED인지 확인한 뒤 반드시 원복한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TARGETS = [
  "src/lib/baseball-qa/pipeline.ts",
  "src/app/(main)/messages/[conversationId]/page.tsx",
  "src/lib/constants/baseball-genius.ts",
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
    name: "M1 인사/감사 매핑 훼손 (greeting에도 headspin)",
    file: TARGETS[0],
    from: 'route === "ack" ? (isGreetingPhrase(question) ? "excited" : "headspin") :',
    to: 'route === "ack" ? "headspin" :',
    expect: "인사 → motion excited",
  },
  {
    name: "M2 거절 bored 매핑 삭제",
    file: TARGETS[0],
    from: 'route === "scope_guide" || route === "blocked" ? "bored" :',
    to: "",
    expect: "scope_guide 거절) → motion bored",
  },
  {
    name: "M3 최신 1개만 훼손 (모든 모션 메시지에 부착)",
    file: TARGETS[1],
    from: `msg.id === latestMotionMessageId
                              ? geniusMotionFromPayload(geniusReply) ?? undefined
                              : undefined`,
    to: "geniusMotionFromPayload(geniusReply) ?? undefined",
    // 이 변이는 "이전 모션 강등" assertion 에서 먼저 죽는다 (모든 메시지에 부착 → 150 이 안 사라짐).
    expect: "이전 모션은 사라진다",
  },
  {
    name: "M4 compose motion 스프레드 삭제 (payload 미탑재)",
    file: TARGETS[2],
    from: "    ...(result.motion ? { motion: result.motion } : {}),\n",
    to: "",
    expect: "motion 이 payload 에 실린다",
  },
  {
    name: "M5 accessor 폐쇄집합 훼손 (임의 문자열 통과)",
    file: TARGETS[2],
    from: `  if (motion === undefined) return null;
  return (GENIUS_MASCOT_MOTIONS as readonly string[]).includes(motion)
    ? (motion as GeniusMascotMotion)
    : null;`,
    to: `  if (motion === undefined) return null;
  return motion as GeniusMascotMotion;`,
    expect: "폐쇄집합",
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
  // OOM(SIGKILL 137)은 판정 불능이지 GREEN이 아니다 — heap 제한 + 1회 재시도 (#1102 실측 축).
  const runOnce = () => spawnSync("npm", ["run", "-s", "qa:genius-mascot-motion"], {
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
  console.error(`FAIL mascot-motion mutations: ${failures}건`);
  process.exit(1);
}
console.log(`PASS mascot-motion mutations: ${mutations.length}/${mutations.length} RED`);
