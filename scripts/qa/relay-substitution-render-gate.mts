/**
 * relay-substitution-render-gate — 크관 피드 교체 행 **실렌더(DOM)** 검증 (#1294 삼순 NO-GO ② 반영).
 *
 * 파서 게이트(qa:relay-substitution)는 playIndex 결속까지만 본다 — RelayInningCard 가 표시를
 * 제거해도 GREEN 이었다(삼순 blocker). 이 게이트는 **production 컴포넌트 RelayInningCard 를
 * 실제로 렌더**(react-dom/server)해 DOM 산출물에서 판정한다:
 *
 *  R1. 투수교체·대타·대주자 라벨 행이 각각 존재한다 (data-testid="relay-sub-row" + data-sub-label).
 *  R2. 타석 사이 순서: 렌더된 행 시퀀스가 기대 시퀀스와 정확히 일치한다
 *      — 투수교체(조상우) → 김건희 타석 → 대타(김웅빈) → 김웅빈 타석 → 대주자(김민규, tail).
 *  R3. reposition(수비위치 변경)은 피드에 렌더되지 않는다.
 *  R4. fail-close: 행이 하나도 안 잡히면(마크업 구조 변경 등) 판정 불능 = FAIL.
 *
 * 렌더 경로는 사본이 아니라 실제 소스 import — mutation 러너(relay-substitution-render-mutations.mjs)가
 * RelayInningCard.tsx 를 변조하고 이 게이트를 별도 프로세스로 실행하면 그 변조가 그대로 판정에 걸린다.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RelayInningCardModule from "../../src/components/game/RelayInningCard";

// tsx(esbuild)가 "use client" 컴포넌트를 CJS interop으로 감싸 default import가
// { default: fn } 객체로 온다 — 실측(typeof object, keys=[default]). 언랩 필수.
const RelayInningCard =
  (RelayInningCardModule as unknown as { default?: React.ComponentType<never> }).default ??
  (RelayInningCardModule as unknown as React.ComponentType<never>);
if (typeof RelayInningCard !== "function") {
  console.error("RENDER-IMPORT: RelayInningCard 컴포넌트 resolve 실패 — 판정 불능(fail-close)");
  process.exit(1);
}
import { TEAMS } from "../../src/lib/constants/teams";
import type { InningRelay } from "../../src/app/api/game-relay/route";

// 2026-08-22 HT:WO 실경기 7회말 축약 — 파서 게이트 픽스처와 동일 시나리오의 "파싱 결과" 형태.
const INNING: InningRelay = {
  inning: 7,
  half: "bottom",
  teamName: "키움",
  plays: [
    { batterName: "김건희", batOrder: 6, result: "중견수 오른쪽 1루타", type: "hit" },
    { batterName: "김웅빈", batOrder: 8, result: "몸에 맞는 볼", type: "hbp" },
  ],
  fielding: [
    { kind: "replace", outPosKr: "투수", outName: "올러", inPosKr: "투수", inName: "조상우", playIndex: 0 },
    { kind: "reposition", name: "한준수", fromPosKr: "대타", toPosKr: "포수", playIndex: 0 },
    { kind: "replace", outPosKr: "8번타자", outName: "어준서", inPosKr: "대타", inName: "김웅빈", playIndex: 1 },
    // 진행 중 타석(대주자) — plays.length(=2) 결속 → 피드 tail 노출 계약.
    { kind: "replace", outPosKr: "1루주자", outName: "김선빈", inPosKr: "대주자", inName: "김민규", playIndex: 2 },
  ],
};

/** 렌더 DOM에서 피드 행 시퀀스를 추출 — 판정 키는 통과 출력과 겹치지 않는 안정 속성(data-*)만. */
export function extractRowSequence(html: string): string[] {
  const seq: string[] = [];
  const re = /data-testid="(relay-sub-row|relay-play-row)"[^>]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    if (m[1] === "relay-sub-row") {
      const label = /data-sub-label="([^"]*)"/.exec(tag)?.[1] ?? "?";
      const inName = /data-sub-in="([^"]*)"/.exec(tag)?.[1] ?? "?";
      seq.push(`sub:${label}:${inName}`);
    } else {
      const batter = /data-play-batter="([^"]*)"/.exec(tag)?.[1] ?? "?";
      seq.push(`play:${batter}`);
    }
  }
  return seq;
}

const EXPECTED_SEQ = [
  "sub:투수교체:조상우",
  "play:김건희",
  "sub:대타:김웅빈",
  "play:김웅빈",
  "sub:대주자:김민규",
];

export function judgeRender(html: string): string[] {
  const failures: string[] = [];
  const seq = extractRowSequence(html);
  if (seq.length === 0) {
    return ["RENDER-EMPTY: 피드 행이 DOM에 하나도 없음 — 판정 불능(fail-close)"];
  }
  if (JSON.stringify(seq) !== JSON.stringify(EXPECTED_SEQ)) {
    failures.push(`RENDER-SEQ: 행 시퀀스 불일치\n  실제: ${JSON.stringify(seq)}\n  기대: ${JSON.stringify(EXPECTED_SEQ)}`);
  }
  for (const label of ["투수교체", "대타", "대주자"]) {
    if (!seq.some((s) => s.startsWith(`sub:${label}:`))) {
      failures.push(`RENDER-LABEL: ${label} 행 부재`);
    }
  }
  if (html.includes("수비위치 변경") || seq.some((s) => s.includes("포수:한준수"))) {
    failures.push("RENDER-REPOSITION: 수비위치 변경이 피드에 렌더됨(필드뷰 전용 계약 위반)");
  }
  return failures;
}

function main(): number {
  const html = renderToStaticMarkup(
    React.createElement(RelayInningCard as React.ComponentType<Record<string, unknown>>, {
      inning: INNING,
      awayTeam: TEAMS.find((t) => t.shortName === "KIA") ?? TEAMS[0],
      homeTeam: TEAMS.find((t) => t.shortName === "키움") ?? TEAMS[1],
      runs: 2,
    }),
  );
  const failures = judgeRender(html);
  if (failures.length > 0) {
    for (const f of failures) console.error(f);
    return 1;
  }
  console.log(`PASS: 실렌더 행 시퀀스 일치 (${extractRowSequence(html).length}행) + reposition 미노출`);
  return 0;
}

process.exit(main());
