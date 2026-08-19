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
  "src/styles/globals.css",
  "src/components/dm/GeniusMascotImage.tsx",
  "src/components/dm/GeniusTypingIndicator.tsx",
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
    from: "{ ...result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole },\n    messageId,",
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
  // ── 2026-08-16 렌더 규격·상시 idle 모션 (하린아빠 지시) ──────────────────
  {
    name: "M15 마스코트 크기를 종전 32px 로 되돌림 (안 보이는 상태 재현)",
    file: TARGETS[2],
    from: 'export const GENIUS_MASCOT_IMG_CLASS = "h-24 w-auto max-w-none object-contain";',
    to: 'export const GENIUS_MASCOT_IMG_CLASS = "h-8 w-auto max-w-none object-contain";',
    expect: "규격 SSOT",
  },
  // ── 2026-08-16 영상 모션 전면 교체 (하린아빠 13:48) ─────────────────────────
  //    종전 M16~M20 은 CSS idle/감정 모션을 훼손했으나 그 코드 자체가 폐기됐다.
  //    같은 자리를 **새 구조의 결함**으로 대체한다.
  {
    name: "M16 §7.6 의미 모션 무시 (인사/감사 구분 소실 — 고마워에 신남이 뜬다)",
    file: TARGETS[2],
    from: '  if (intent === "excited" || intent === "headspin" || intent === "bored") {',
    to: '  if (false) {',
    expect: "의미 매핑",
  },
  {
    // 🔴 쿨다운 거절은 **실경로**다(삼순 2026-08-16 P0). 의미(intent)를 버리고
    //    부여(granted)만 보면, 30초 내 재인사에서 감사·인사·범위안내가 한 폴백으로 무너진다.
    name: "M26 의도 모션 폐기 (쿨다운 거절 시 감사/인사/범위안내 구분 소실)",
    file: TARGETS[2],
    from: "  const intent = context?.motionIntent ?? context?.motion\n",
    to: "  const intent = context?.motion\n",
    expect: "쿨다운 거절",
  },
  {
    // 억제는 "감정을 재생하지 않는다"이지 "아무 감정이나 붙인다"가 아니다.
    name: "M27 쿨다운 거절을 다른 감정으로 대체 (억제가 오답을 만든다)",
    file: TARGETS[2],
    from: "    if (granted === intent) return intent;\n    return NEUTRAL_ACK_CLIP;",
    to: "    return intent;",
    expect: "쿨다운 거절",
  },
  {
    // bored 를 쿨다운 예외로 되돌리면 §7.4 계약을 리뷰 승인 없이 바꾸는 것이다(삼순 보완).
    name: "M28 bored 를 쿨다운 예외로 되돌림 (§7.4 계약 무단 변경)",
    file: TARGETS[2],
    from: '  if (intent === "excited" || intent === "headspin" || intent === "bored") {',
    to: '  if (intent === "bored") return "bored";\n  if (intent === "excited" || intent === "headspin") {',
    expect: "쿨다운 거절",
  },
  {
    // 서버가 intent 를 안 실으면 위 계약 전체가 허공이다.
    name: "M29 server 가 motionIntent 를 payload 에 안 싣는다",
    file: TARGETS[3],
    from: "{ ...result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole },",
    to: "{ ...result, motion, answerTeamId, answerPlayerRole },",
    expect: "motionIntent",
  },
  {
    name: "M22 응원 최애팀 결속 해제 (모든 답변에 응원 — 14:09 지시 위반)",
    file: TARGETS[2],
    from: '  if (isFavoriteTeamAnswer(context?.answerTeamId, context?.favoriteTeamId)) {',
    to: '  if (true) {',
    expect: "응원 fail-close",
  },
  {
    name: "M23 응원 자격을 느슨하게 (한쪽만 있어도 통과 — 남의 팀에 응원)",
    file: TARGETS[2],
    from: '  return isRealTeamId(answerTeamId) && isRealTeamId(favoriteTeamId) &&',
    to: '  return (answerTeamId != null) && (favoriteTeamId != null) &&',
    expect: "응원 fail-close",
  },
  {
    name: "M24 server 가 응원 자격 팀 id 를 payload 에 안 싣는다 (응원 영영 미도달)",
    file: TARGETS[3],
    from: '{ ...result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole }',
    to: '{ ...result, motion, motionIntent: candidateMotion, answerPlayerRole }',
    expect: "응원 자격",
  },
  {
    name: "M25 응원 자격을 거절 경로에도 부여 (차단인데 응원이 뜬다)",
    file: TARGETS[0],
    from: '  if (replyKindForMatchPath(source) !== "answer") return null;',
    to: '  if (false) return null;',
    expect: "응원",
  },
  {
    name: "M17 정상답변을 단일 클립으로 (같은 동작만 반복 — 정적 이미지처럼 보임)",
    file: TARGETS[2],
    from: 'const ANSWER_CLIPS = ["swing", "pitching"] as const;',
    to: 'const ANSWER_CLIPS = ["swing"] as const;',
    expect: "야구 동작 2종 교대",
  },
  {
    name: "M18 reduced-motion poster 대체 제거 (모션 줄이기에서도 계속 재생)",
    file: TARGETS[6],
    from: '      <source\n        media="(prefers-reduced-motion: reduce)"',
    to: '      <source\n        media="(min-width: 0px)"',
    expect: "reduced-motion",
  },
  {
    name: "M19 공유 컴포넌트 우회 (생각중 마스코트를 인라인 img 로 복제)",
    file: TARGETS[7],
    from: '<GeniusMascotImage\n              replyKind="picker"\n              messageId={0}\n              testId="genius-thinking-mascot"\n            />',
    to: '<img src="/mascot/motion/thinking.webp" alt="" aria-hidden data-testid="genius-thinking-mascot" data-clip="thinking" className="h-8 w-auto max-w-none object-contain" />',
    expect: "단일 지점",
  },
  {
    name: "M20 클립을 정적 poster 로 바꿔치기 (파일은 있는데 안 움직임)",
    file: TARGETS[2],
    from: '  return `/mascot/motion/${clip}.webp`;',
    to: '  return `/mascot/motion/${clip}-poster.webp`;',
    expect: "실제 애니메이션",
  },
  {
    name: "M30 역할 클립 매핑 반전 (투수에 스윙 — 제보 사고 재현)",
    file: TARGETS[2],
    from: '  pitcher: "pitching",\n  batter: "swing",',
    to: '  pitcher: "swing",\n  batter: "pitching",',
    expect: "역할 클립",
  },
  {
    name: "M31 역할 분기 제거 (교대로 회귀 — 타자에 투구모션 재발)",
    file: TARGETS[2],
    from: '  const role = context?.answerPlayerRole;\n  if (role === "pitcher" || role === "batter") return ROLE_CLIPS[role];',
    to: '',
    expect: "역할 클립",
  },
  {
    name: "M32 server 가 선수 역할을 payload 에 안 싣는다 (역할 모션 영영 미도달)",
    file: TARGETS[3],
    from: '{ ...result, motion, motionIntent: candidateMotion, answerTeamId, answerPlayerRole },',
    to: '{ ...result, motion, motionIntent: candidateMotion, answerTeamId },',
    expect: "server 배선",
  },
  {
    name: "M33 역할 판정을 거절 경로에도 부여 (차단인데 역할 모션)",
    file: TARGETS[0],
    from: '  const replyKindOfSource = replyKindForMatchPath(source);\n  if (replyKindOfSource !== "answer") return null;',
    to: '  if (false) return null;',
    expect: "역할",
  },
  {
    name: "M34 동명이인 역할 혼재 수렴 제거 (한쪽 역할을 먋대로 확정)",
    file: TARGETS[0],
    from: '  if (roles.size !== 1) return null;',
    to: '  if (roles.size === 0) return null;',
    expect: "역할",
  },
  {
    name: "M35 picked 결속 제거 — raw question 재계산으로 회귀 (picker 선택 무시, 삼순 P1 재현)",
    file: TARGETS[0],
    from: '  const pickedKboId = target.pickedPlayerKboId?.normalize("NFKC").trim() ?? "";\n  if (pickedKboId.length > 0) {\n    const picked = players.find((player) => player.kboId === pickedKboId);\n    return picked ? playerRoleOfPosition(picked.position) : null;\n  }',
    to: '',
    expect: "역할 결속",
  },
  {
    name: "M36 picked 미존재 시 질문 기반으로 fallback (안 고른 동명이인 역할 부착)",
    file: TARGETS[0],
    from: '    return picked ? playerRoleOfPosition(picked.position) : null;',
    to: '    if (picked) return playerRoleOfPosition(picked.position);\n  }\n  if (false) {',
    expect: "역할 결속",
  },
  {
    name: "M37 server 가 job 행 대신 raw question 만 쓴다 (durable 경로 결속 삭제)",
    file: TARGETS[3],
    from: '        pickedPlayerKboId: input.pickedPlayerKboId\n          ?? (targetJob?.picked_player_kbo_id as string | null ?? null),\n        correctedQuestion: targetJob?.picked_normalized_question as string | null ?? null,',
    to: '        pickedPlayerKboId: null,\n        correctedQuestion: null,',
    expect: "역할",
  },
  {
    name: "M21 legacy(payload 없는 과거 답변)를 정지 상태로 되돌림",
    file: TARGETS[2],
    from: '  // answer + legacy(null/undefined/모르는 값) — 둘 다 야구 동작으로 살아있게 둔다.\n  return ANSWER_CLIPS[seed % ANSWER_CLIPS.length];',
    to: '  if (replyKind === undefined || replyKind === null) return "thinking";\n  return ANSWER_CLIPS[seed % ANSWER_CLIPS.length];',
    expect: "legacy(null/undefined) 도 야구 동작",
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
