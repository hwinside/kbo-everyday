#!/usr/bin/env node
/**
 * cancel-reason-gate (npm run qa:cancel-reason / :selftest)
 *
 * 계약 (2026-08-22, #cs 유저 제보 "경기가 왜 취소 됬는지 적어줫으면 좋겠어요"):
 *
 *  C1. 사유는 **취소 상태일 때만** 값을 가진다(값-플래그 결속).
 *      상태가 live/final/scheduled 로 뒤집힌 경기에 사유만 남으면 UI 가 취소로 오표기한다.
 *      → parseCancelReason(status, name) 이 status !== "cancelled" 면 무조건 null.
 *
 *  C2. 사유 부재는 **"사유 없는 취소"가 아니라 "못 받았다"** 이다(provenance).
 *      Naver 폴백 경로에는 CANCEL_SC_NM 이 원리적으로 없다. 빈 문자열로 합성하면
 *      "사유 없음"으로 오독되므로 null 을 유지하고, 표시면은 기존 고정 문구로 fallback 한다.
 *      → normalizeCancelReason("")·null·undefined 는 전부 null.
 *
 *  C3. upstream 열화 값(장문·제어문자)을 사용자에게 그대로 흘리지 않는다.
 *      → 상한 초과·제어문자 포함이면 null(= 고정 문구 fallback).
 *
 *  C4. 표시 문구를 조립하지 않는다. KBO 사유(`우천취소`)는 이미 완결 명사구라
 *      `${사유} 취소` 로 만들면 `우천취소 취소` 가 된다. 배지는 원문 그대로.
 *
 *  C5. 표시면 배선 — 취소 사유를 렌더해야 하는 화면이 실제로 헬퍼를 통해 값을 읽는다.
 *      (경기상세 배너 / 크관탭 / 홈 마이팀 / 홈 오늘의경기 / 경기목록 카드 / 팀 일정)
 *
 *  C6. 실제 KBO 응답 파서가 사유를 실어 나른다 — 고정 픽스처를 parseGame 에 통과시켜
 *      `우천취소`/`폭염취소`/`그라운드사정` 이 그대로 나오는지 확인한다(원문 보존).
 *
 * 이 게이트는 **순수 함수를 직접 실행**하고(문자열 존재 확인이 아님), 배선만 소스 검사한다.
 * 소스 검사 구간은 주석/문서 문면을 blank 처리해 "주석이 assertion 을 만족시키는"
 * false-green(2026-08-19 #1256 자기결함)을 구조적으로 차단한다.
 *
 * --selftest: 임계 반전이 아니라 **실제 소스 변이**로 RED 를 증명한다(자식 프로세스 재실행).
 */
// ⚠️ 첫 import 여야 한다 — kbo-api 는 트랜지티브로 supabase/admin 싱글턴을 로드하고,
//   그 싱글턴이 모듈 평가 시점에 SUPABASE env 를 요구한다. 순수 함수만 검증하므로 더미 선주입.
import "./_smoke-env";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SELFTEST = process.argv.includes("--selftest");

/** 주석·문서 문면이 assertion 을 만족시키지 못하게 blank 처리(오프셋 보존). */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length))
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, (m) => m.replace(/[^\n]/g, " "));
}

function readStripped(rel) {
  return stripComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

const failures = [];
function check(id, ok, detail) {
  if (ok) {
    console.log(`  PASS  ${id}`);
  } else {
    failures.push(`${id}: ${detail}`);
    console.error(`  ❌ FAIL  ${id} — ${detail}`);
  }
}

// ── 순수 함수 로드 (tsx 로 실행되므로 TS 직접 import 가능)
const { parseCancelReason } = await import("../../src/lib/crawler/kbo-api.ts");
const { normalizeCancelReason, cancelReasonBadge, cancelReasonDetail } = await import(
  "../../src/lib/utils/cancel-reason.ts"
);

console.log("── C1 값-플래그 결속: 사유는 cancelled 일 때만");
for (const status of ["scheduled", "live", "final"]) {
  check(
    `C1-${status}`,
    parseCancelReason(status, "우천취소") === null,
    `status=${status} 인데 사유가 실렸다 → ${JSON.stringify(parseCancelReason(status, "우천취소"))}`,
  );
}
check(
  "C1-cancelled",
  parseCancelReason("cancelled", "우천취소") === "우천취소",
  `cancelled 인데 사유가 null → ${JSON.stringify(parseCancelReason("cancelled", "우천취소"))}`,
);

console.log("── C2 provenance: 부재는 '사유 없음'이 아니라 '미확인'(null)");
for (const [label, input] of [
  ["빈문자열", ""],
  ["공백만", "   "],
  ["null", null],
  ["undefined", undefined],
]) {
  check(
    `C2-${label}`,
    normalizeCancelReason(input) === null && parseCancelReason("cancelled", input) === null,
    `${label} 가 null 로 정규화되지 않았다`,
  );
}
check(
  "C2-detail-null",
  cancelReasonDetail(null) === null,
  "사유 미확인인데 detail 문구가 생성됐다(고정 문구 fallback 이 깨진다)",
);
check(
  "C2-badge-fallback",
  cancelReasonBadge(null) === "취소" && cancelReasonBadge("") === "취소",
  `미확인 배지 fallback 이 '취소' 가 아니다 → ${JSON.stringify(cancelReasonBadge(null))}`,
);

console.log("── C3 열화 값 차단");
check("C3-long", normalizeCancelReason("가".repeat(21)) === null, "상한 초과 장문이 그대로 노출된다");
check("C3-boundary", normalizeCancelReason("가".repeat(20)) === "가".repeat(20), "상한 이내 값이 잘렸다");
check("C3-control", normalizeCancelReason("우천\u0000취소") === null, "제어문자 포함 값이 그대로 노출된다");

console.log("── C4 문구 조립 금지(원문 보존)");
for (const reason of ["우천취소", "폭염취소", "그라운드사정"]) {
  const badge = cancelReasonBadge(reason);
  check(
    `C4-${reason}`,
    badge === reason,
    `배지가 원문과 다르다 → ${JSON.stringify(badge)} (문구 조립은 '우천취소 취소' 중복을 만든다)`,
  );
}
check(
  "C4-detail-format",
  cancelReasonDetail("우천취소") === "사유: 우천취소",
  `detail 문구 계약 위반 → ${JSON.stringify(cancelReasonDetail("우천취소"))}`,
);

console.log("── C5 표시면 배선(주석 blank 처리 후 검사)");
/** [파일, [정규식, 설명]...] */
const WIRING = [
  [
    "src/app/(main)/games/[gameId]/page.tsx",
    [
      [/cancelReasonDetail\s*\(\s*d\.cancelReason\s*\)/, "경기상세 취소 배너가 사유를 읽지 않는다"],
      [/cancelReason=\{d\.cancelReason\}/, "KgwanTab 에 사유를 넘기지 않는다"],
    ],
  ],
  [
    "src/components/game/KgwanTab.tsx",
    [[/cancelReasonDetail\s*\(\s*cancelReason\s*\)/, "크관탭 CancelledView 가 사유를 읽지 않는다"]],
  ],
  [
    "src/components/home/MyTeamHero.tsx",
    [[/normalizeCancelReason\s*\(\s*myTeamGame\.cancelReason\s*\)/, "홈 마이팀 카드가 사유를 읽지 않는다"]],
  ],
  [
    "src/components/home/TodayGamesSection.tsx",
    [[/cancelReasonBadge\s*\(\s*game\.cancelReason\s*\)/, "홈 오늘의경기 행이 사유를 읽지 않는다"]],
  ],
  [
    "src/components/game/CompactGameCard.tsx",
    [[/cancelReasonBadge\s*\(\s*game\.cancelReason\s*\)/, "경기목록 카드가 사유를 읽지 않는다"]],
  ],
  [
    "src/app/(main)/teams/[teamId]/schedule/page.tsx",
    [[/cancelReasonBadge\s*\(\s*game\.cancelReason\s*\)/, "팀 일정 셀이 사유를 읽지 않는다"]],
  ],
  [
    "src/lib/utils/game-derived.ts",
    [
      [
        /derivedStatus\s*===\s*"cancelled"\s*\n?\s*\?\s*\(gameDetail\?\.cancelReason\s*\?\?\s*liveGame\?\.cancelReason\s*\?\?\s*null\)/,
        "derivedStatus 결속 없이 사유가 흘러나온다(상태 뒤집힘 시 오표기)",
      ],
    ],
  ],
  // 홈 **초기 진입(SSR)** 경로 — useHomeInit 은 initialGames 가 있으면 클라이언트 재조회를
  // 건너뛰므로, 이 경로가 사유를 버리면 첫 화면은 영영 고정 문구로 남는다(삼순 NO-GO ①).
  [
    "src/app/(main)/page.tsx",
    [[/cancelReason:\s*g\.status\s*===\s*"cancelled"/, "홈 SSR 경기목록 매핑이 사유를 버린다"]],
  ],
  [
    "src/lib/crawler/home-live-games.ts",
    [[/cancelReason:\s*g\.status\s*===\s*"cancelled"/, "홈 SSR live 변환이 사유를 버린다"]],
  ],
  [
    "src/components/home/HomeClientShell.tsx",
    [
      [
        /cancelReason:\s*merged\s*===\s*"cancelled"/,
        "myTeamLive 병합이 사유를 버려 MyTeamHero 가 고정 문구로 남는다",
      ],
    ],
  ],
  // ScoreBoard 파서는 문자열 포함이 아니라 **코드**에 결속돼야 한다(삼순 NO-GO ②).
  [
    "src/lib/services/game-detail.ts",
    [[/isKboGameCancelled\(m\.CANCEL_SC_ID\)/, "ScoreBoard 취소 판정이 CANCEL_SC_ID 에 결속되지 않았다"]],
  ],
];
for (const [file, contracts] of WIRING) {
  const src = readStripped(file);
  for (const [re, desc] of contracts) {
    check(`C5-${file.split("/").pop()}-${re.source.slice(0, 24)}`, re.test(src), `${desc} (${file})`);
  }
}

console.log("── C6 KBO 파서 종단: 2026-08 실측 응답 형태 픽스처");
const { parseGame } = await import("../../src/lib/crawler/kbo-api.ts");
const { mapNaverGameToKbo } = await import("../../src/lib/crawler/naver-games.ts");

/** 2026-08 KBO GetKboGameList 실측 형태(사유 3종 + 정상 경기). */
function rawGame(over) {
  return {
    G_ID: "20260816NCLT0", G_DT: "20260816", G_TM: "18:30", S_NM: "창원",
    AWAY_ID: "NC", HOME_ID: "LT", AWAY_NM: "NC", HOME_NM: "롯데",
    T_SCORE_CN: "0", B_SCORE_CN: "0", GAME_INN_NO: 0, GAME_TB_SC: "T",
    GAME_STATE_SC: "1", CANCEL_SC_ID: "0", CANCEL_SC_NM: "",
    T_PIT_P_NM: "", B_PIT_P_NM: "", W_PIT_P_NM: "", L_PIT_P_NM: "", SV_PIT_P_NM: "",
    STRIKE_CN: 0, BALL_CN: 0, OUT_CN: 0,
    B1_BAT_ORDER_NO: 0, B2_BAT_ORDER_NO: 0, B3_BAT_ORDER_NO: 0,
    B_P_NM: "", T_P_NM: "", T_RANK_NO: 1, B_RANK_NO: 2,
    ...over,
  };
}

const FIXTURES = [
  ["우천취소", { CANCEL_SC_ID: "1", CANCEL_SC_NM: "우천취소" }, "cancelled", "우천취소"],
  ["폭염취소", { CANCEL_SC_ID: "9", CANCEL_SC_NM: "폭염취소" }, "cancelled", "폭염취소"],
  ["그라운드사정", { CANCEL_SC_ID: "6", CANCEL_SC_NM: "그라운드사정" }, "cancelled", "그라운드사정"],
  // 사유 필드가 통째로 빠진 부분 열화 — 취소지만 사유는 미확인(null)이어야 한다.
  ["사유필드부재", { CANCEL_SC_ID: "1", CANCEL_SC_NM: undefined }, "cancelled", null],
  // 정상 경기 — 사유가 절대 실리면 안 된다.
  ["정상경기", {}, "scheduled", null],
];

for (const [label, over, expectStatus, expectReason] of FIXTURES) {
  const parsed = parseGame(rawGame(over));
  check(
    `C6-${label}-status`,
    parsed.status === expectStatus,
    `status 기대 ${expectStatus} → 실제 ${parsed.status}`,
  );
  check(
    `C6-${label}-reason`,
    parsed.cancelReason === expectReason,
    `사유 기대 ${JSON.stringify(expectReason)} → 실제 ${JSON.stringify(parsed.cancelReason)}`,
  );
}

// Naver 폴백 매퍼는 사유를 원리적으로 모른다 — 빈 문자열 합성 금지, null 유지.
{
  const naverCancelled = mapNaverGameToKbo(
    {
      gameId: "20260816NCLT0", gameDateTime: "2026-08-16T18:30:00",
      awayTeamCode: "NC", homeTeamCode: "LT", awayTeamName: "NC", homeTeamName: "롯데",
      stadium: "창원", statusCode: "CANCEL", cancel: true,
      awayTeamScore: 0, homeTeamScore: 0,
    },
    "20260816",
  );
  check(
    "C6-naver-fallback-null",
    naverCancelled.status === "cancelled" && naverCancelled.cancelReason === null,
    `Naver 폴백이 사유를 합성했다 → ${JSON.stringify(naverCancelled.cancelReason)} (부재는 null 이어야 한다)`,
  );
}

if (failures.length > 0) {
  console.error(`\n❌ cancel-reason-gate FAIL — ${failures.length}건`);
  for (const f of failures) console.error(`  · ${f}`);
  process.exit(1);
}
console.log(`\n✅ cancel-reason-gate PASS`);

// ───────────────────────── selftest: 실제 변이로 RED 증명 ─────────────────────────
if (SELFTEST) {
  console.log("\n── selftest: 소스 변이 주입 → 자식 게이트 RED 기대");
  /** [id, 파일, 앵커, 치환, 설명] */
  const MUTATIONS = [
    [
      "S1-drop-status-binding",
      "src/lib/crawler/kbo-status.ts",
      'if (status !== "cancelled") return null;',
      "",
      "값-플래그 결속 제거 → 정상 경기에도 사유가 실린다",
    ],
    [
      "S2-empty-string-instead-of-null",
      "src/lib/utils/cancel-reason.ts",
      "if (trimmed.length === 0) return null;",
      'if (trimmed.length === 0) return "사유 미상";',
      "부재를 '사유 미상'으로 단정 → provenance 계약 붕괴",
    ],
    [
      "S3-compose-badge",
      "src/lib/utils/cancel-reason.ts",
      'return normalizeCancelReason(reason) ?? "취소";',
      'const r = normalizeCancelReason(reason); return r ? `${r} 취소` : "취소";',
      "문구 조립 부활 → '우천취소 취소' 중복",
    ],
    [
      "S4-unwire-detail-banner",
      "src/app/(main)/games/[gameId]/page.tsx",
      "cancelReasonDetail(d.cancelReason) ??",
      "null ??",
      "경기상세 배너 배선 제거 → 사유가 화면에 안 닿는다",
    ],
  ];

  const tmp = mkdtempSync(path.join(tmpdir(), "cancel-reason-selftest-"));
  let selftestFailed = 0;
  for (const [id, rel, anchor, replace, desc] of MUTATIONS) {
    const abs = path.join(ROOT, rel);
    const original = readFileSync(abs, "utf8");
    if (!original.includes(anchor)) {
      selftestFailed++;
      console.error(`  ❌ ${id}: 앵커 MISS — '${anchor}' 없음 (러너 결함, 즉시 수선)`);
      continue;
    }
    copyFileSync(abs, path.join(tmp, path.basename(rel) + ".bak"));
    writeFileSync(abs, original.replace(anchor, replace), "utf8");
    try {
      execFileSync("npx", ["tsx", "scripts/qa/cancel-reason-gate.mjs"], {
        cwd: ROOT,
        stdio: "pipe",
        encoding: "utf8",
      });
      selftestFailed++;
      console.error(`  ❌ ${id}: 결함 주입에도 GREEN — 게이트에 검출력이 없다 (${desc})`);
    } catch {
      console.log(`  PASS  ${id}: RED 확인 — ${desc}`);
    } finally {
      writeFileSync(abs, original, "utf8");
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  if (selftestFailed > 0) {
    console.error(`\n❌ selftest FAIL — ${selftestFailed}건`);
    process.exit(1);
  }
  console.log("\n✅ selftest PASS — 전 변이에서 RED");
}
