#!/usr/bin/env node
// `qa:genius-mascot-motion` 검출력 증명. 실제 배포 소스를 한 축씩 훼손하고
// 지정 assertion으로 RED인지 확인한 뒤 반드시 원복한다.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const TARGETS = [
  "src/lib/baseball-qa/pipeline.ts",
  "src/app/(main)/messages/[conversationId]/page.tsx",
  "src/lib/constants/baseball-genius.ts",
  "src/lib/baseball-qa/server.ts",
  "src/lib/supabase/dm-messages.ts",
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
    from: 'if (source === "ack") return isGreetingPhrase(question) ? "excited" : "headspin";',
    to: 'if (source === "ack") return "headspin";',
    expect: "인사 → excited",
  },
  {
    name: "M2 거절 bored 매핑 삭제",
    file: TARGETS[0],
    from: '  if (source === "scope_guide" || source === "blocked") return "bored";\n',
    to: "",
    expect: "bored",
  },
  {
    name: "M3 reply 최신 1개 훼손 (모든 봇 답변에 마스코트 부착)",
    file: TARGETS[1],
    from: `msg.sender_id === BASEBALL_GENIUS_USER_ID && msg.id === latestGeniusMessageId &&
              mascotOwner.kind === "reply"`,
    to: "msg.sender_id === BASEBALL_GENIUS_USER_ID",
    // 이 변이는 "이전 답변 마스코트 완전 제거" assertion 에서 먼저 죽는다(전 봇 답변 부착).
    expect: "완전히 사라진다",
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
  {
    name: "M6 server 단일 지점 motion 배선 제거 (ready 재시도 소실 재현)",
    file: TARGETS[3],
    from: "{ ...result, motion },\n    messageId,",
    to: "result,\n    messageId,",
    expect: "compose 가 DB 가 승인한 motion",
  },
  {
    name: "M7 thinking showMascot 소유권 우회 (항상 노출)",
    file: TARGETS[1],
    from: 'showMascot={mascotOwner.kind === "thinking" && mascotOwner.id === msg.id}',
    to: "showMascot={true}",
    expect: "생각중 마스코트는 숨는다",
  },
  {
    name: "M8 failed showMascot 소유권 우회 (항상 노출)",
    file: TARGETS[1],
    from: 'showMascot={mascotOwner.kind === "failed" && mascotOwner.id === Number(messageId)}',
    to: "showMascot={true}",
    expect: "failed 마스코트는 숨는다",
  },
  {
    name: "M12 원자 claim 우회 (후보 모션을 그대로 부착 — SELECT→INSERT race 재현)",
    file: TARGETS[3],
    from: "      motion = granted === null ? undefined : (granted as typeof candidateMotion);",
    to: "      motion = candidateMotion;",
    expect: "RPC 반환값에서만",
  },
  {
    name: "M13 연속 고정문 우회 (streak 무시)",
    file: TARGETS[0],
    from: "        if (streak >= SMALLTALK_STREAK_LIMIT) {",
    to: "        if (false) {",
    expect: "연속",
  },
  {
    name: "M14 payload 이월 시각 미전달 (배포 직후 무조건 부여)",
    file: TARGETS[3],
    from: "          p_payload_last_motion_at: (lastMotionRow?.created_at as string | undefined) ?? null,",
    to: "          p_payload_last_motion_at: null,",
    expect: "payload 모션 시각도 넘긴다",
  },
  {
    name: "M10 칭찬 폐쇄집합 삭제 (대표 칭찬이 ack 이 아니게 됨)",
    file: TARGETS[0],
    from: '  "잘했어", "잘했어요", "잘하네", "잘하네요", "잘한다", "잘하는데",\n',
    to: "",
    expect: "대표 칭찬",
  },
  {
    name: "M11 polling merge 훼손 (재조회 결과를 버림)",
    file: "src/lib/supabase/dm-messages.ts",
    from: "  for (const m of incoming) byId.set(m.id, m);",
    to: "",
    expect: "polling merge",
  },
  {
    name: "M9 역순 방어 훼손 (마지막 도착이 소유권 탈취)",
    file: TARGETS[1],
    from: "      if (latest === null || m.id > latest) latest = m.id;",
    to: "      latest = m.id;",
    expect: "역순",
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
