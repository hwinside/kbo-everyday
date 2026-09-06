#!/usr/bin/env node
/**
 * `qa:genius-product-feature-guide` **검출력 증명** — 실제 배포 소스를 한 축씩 훼손하고
 * 게이트가 RED 인지 확인한 뒤 반드시 원복한다 (2026-09-05).
 *
 * ⚠️ 계약 4가지 (M90 `게이트를 쓴 직후 4개를 스스로 묻는다`):
 *   ① 각 mutation 은 **실제 RED 를 낼 수 있는 경로**를 훼손한다.
 *   ② 판정 키는 실패 줄에만 나오는 안정 ID `[PFG-FAIL]` 이다.
 *   ③ **패치 미적용은 PASS 가 아니라 FAIL** 이다(anchor MISS = 검증력 0).
 *   ④ 태우는 경로는 게이트가 실제로 import 하는 production seam 이다(사본 없음).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

const PIPELINE = "src/lib/baseball-qa/pipeline.ts";
const TARGETS = [PIPELINE];

const originals = new Map(TARGETS.map((f) => [f, fs.readFileSync(f, "utf8")]));
const restore = () => {
  for (const [f, src] of originals) fs.writeFileSync(f, src);
};
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => { restore(); process.exit(130); });
}

const MUTATIONS = [
  {
    name: "M1 토큰 시작 일치 → 부분문자열 포함",
    why: "`플레이 스타일` 의 `스타일` 이 `타일` 로 잡혀 야구 질문이 워치 안내로 간다",
    file: PIPELINE,
    re: /    if \(!token\.startsWith\(compactTrigger\)\) continue;/,
    to: "    if (!token.includes(compactTrigger)) continue; // [mutant M1]",
  },
  {
    name: "M2 앱 문맥 술어 제거",
    why: "`올해 순위 어떻게 돼?` 가 앱 순위 안내로 가로채인다",
    file: PIPELINE,
    re: /    if \(spec\.needsAppContext === true && !PRODUCT_FEATURE_APP_CONTEXT\.test\(normalized\)\) continue;/,
    to: "    // [mutant M2] 앱 문맥 술어 제거",
  },
  {
    name: "M3 변경 요청 술어 제거",
    why: "`너의 최애 선수는 누구니` 류 잡담이 최애선수 등록 안내로 간다",
    file: PIPELINE,
    re: /    if \(spec\.requiresChangeAsk === true && !PRODUCT_FEATURE_CHANGE_ASK\.test\(normalized\)\) continue;/,
    to: "    // [mutant M3] 변경 술어 제거",
  },
  {
    name: "M4 비교·배제 조사 예외 제거",
    why: "`직관기록보다 중요한거` 가 기능 질문이 된다(종전 문서 계약 위반)",
    file: PIPELINE,
    re: /const PRODUCT_FEATURE_EXCLUDED_TAIL = \/\^\(\?:보다\|보단\|말고\|빼고\)\/u;/,
    to: "const PRODUCT_FEATURE_EXCLUDED_TAIL = /^(?!)/u; // [mutant M4] 아무것도 배제하지 않음",
  },
  {
    name: "M5 라우터 배선 절단",
    why: "판정기가 멀쩡해도 라우터가 안 부르면 `이 크보팬앱이 워치에도…` 는 service_redirect 로 끝난다(wiring 도 계약)",
    file: PIPELINE,
    re: /  if \(resolveProductFeature\(question\) !== null\) return "product_feature_guide";/,
    to: '  if (false) return "product_feature_guide"; // [mutant M5]',
  },
  {
    name: "M6 트리거 삭제(워치)",
    why: "registry 트리거가 빠지면 `워치 설정 어떻게 해?` 가 다시 unsure 로 간다",
    file: PIPELINE,
    re: /    triggers: \["워치", "갤럭시워치", "애플워치", "스마트워치", "타일", "컴플리케이션", "watch"\],/,
    to: '    triggers: ["갤럭시워치", "애플워치", "스마트워치", "타일", "컴플리케이션", "watch"], // [mutant M6]',
  },
  {
    name: "M7 문구에서 출시본 메뉴 경로 제거(잠금화면)",
    why: "라벨은 맞는데 문구가 출시본 경로를 안 담으면 유저는 다음 행동을 못 한다(삼순: 키 추가만으로 완료 아님)",
    file: PIPELINE,
    re: /마이페이지 > 설정 > 잠금화면 > 잠금화면 실시간 중계를 켜면/,
    to: "설정에서 켜면", // [mutant M7]
  },
  {
    name: "M8 총함수 문구 공백화",
    why: "라우팅은 성공으로 남고 유저에겐 빈 답이 간다(감사 지표 거짓말)",
    file: PIPELINE,
    re: /  return PRODUCT_FEATURE_REGISTRY\[feature\]\.answer;/,
    to: '  return ""; // [mutant M8]',
  },
  {
    name: "M9 이용 의도·기록 질문 게이트 제거 (삼순 ①)",
    why: "`최애팀 몇 위?`·`응원팀이 삼성인데 오늘 이길까` 가 단어 존재만으로 기능 안내가 된다",
    file: PIPELINE,
    re: /    if \(!usageAsk \|\| statOnly\) continue;/,
    to: "    // [mutant M9] 이용 의도 게이트 제거",
  },
  {
    name: "M10 시청처 술어 제거 (삼순 ②)",
    why: "`감독 인터뷰에서 뭐라고 했어`·`중계권료가 얼마야` 가 외부 시청 안내로 간다",
    file: PIPELINE,
    re: /    if \(spec\.viewingAsk === true && !PRODUCT_FEATURE_VIEWING_ASK\.test\(normalized\)\) continue;/,
    to: "    // [mutant M10] 시청처 술어 제거",
  },
  {
    name: "M11 외부 시청 항목의 '앱 안에서 재생되지 않음' 선언 제거 (삼순 ②)",
    why: "`TV 중계 어디서 봐?` 가 문자중계 안내로 시작해 앱 사용법과 외부 시청이 다시 섞인다",
    file: PIPELINE,
    re: /"TV·온라인 영상 중계는 크보팬 안에서 재생되지 않습니다\. /,
    to: '"', // [mutant M11]
  },
  {
    name: "M12 answerQuestion 조립에서 registry 문구 절단 (삼순 ③)",
    why: "라우터·판정기는 GREEN 인데 종단 답변은 BLOCKED 가 나간다 — routeQuestion 만 보는 게이트는 이걸 못 잡는다",
    file: PIPELINE,
    re: /      route === "product_feature_guide" && productFeatureAnswer !== null \? productFeatureAnswer :/,
    to: '      route === "product_feature_guide" && false ? productFeatureAnswer :', // [mutant M12]
  },
  {
    name: "M13 문구에 출시본에 없는 최소버전·단일 플랫폼 전용 단정 삽입 (삼순 ④)",
    why: "stale CS 캐시를 베낀 '아이폰 전용·1.0.9 이상' 류 사실 오류가 게이트를 통과한다",
    file: PIPELINE,
    re: /"잠금화면 실시간 중계는 아이폰\(iOS 18 이상\)과 안드로이드/,
    to: '"잠금화면 실시간 중계는 아이폰 전용입니다(앱 1.0.9 이상). 아이폰(iOS 18 이상)과 안드로이드', // [mutant M13]
  },
];

function gatePasses() {
  const r = spawnSync("npx", ["tsx", "scripts/qa/genius-product-feature-guide.ts"], { encoding: "utf8" });
  return r.status === 0;
}
function gateFailureMentionsId() {
  const r = spawnSync("npx", ["tsx", "scripts/qa/genius-product-feature-guide.ts"], { encoding: "utf8" });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`.includes("[PFG-FAIL]");
}

function main() {
  process.stdout.write("[baseline] 게이트 확인 중...\n");
  if (!gatePasses()) {
    console.error("❌ baseline 이 이미 FAIL — mutant 판정 불가(fail-close)");
    process.exit(1);
  }
  console.log("✅ baseline GREEN\n");

  let survived = 0;
  let unapplied = 0;
  for (const m of MUTATIONS) {
    const original = originals.get(m.file);
    if (!m.re.test(original)) {
      console.error(`❌ ${m.name}: 앵커를 소스에서 찾지 못했다 (${m.file}) — mutant 미적용`);
      unapplied += 1;
      continue;
    }
    try {
      fs.writeFileSync(m.file, original.replace(m.re, m.to));
      const passed = gatePasses();
      if (passed) {
        console.error(`❌ ${m.name}: mutant 가 살아남았다 — 이 축은 검사되지 않는다\n   ${m.why}`);
        survived += 1;
      } else if (!gateFailureMentionsId()) {
        console.error(`❌ ${m.name}: RED 이지만 [PFG-FAIL] 이 없다 — 계약 위반이 아니라 크래시 의심`);
        survived += 1;
      } else {
        console.log(`✅ ${m.name}: RED`);
      }
    } finally {
      fs.writeFileSync(m.file, original);
    }
  }
  if (!gatePasses()) {
    console.error("\n❌ 복원 후 baseline 이 RED — 원본 복원 실패(워크트리 오염)");
    process.exit(1);
  }
  const total = MUTATIONS.length;
  if (survived > 0 || unapplied > 0) {
    console.error(`\n❌ product-feature-guide mutations FAIL — 생존 ${survived} · 미적용 ${unapplied} / ${total}`);
    process.exit(1);
  }
  console.log(`\n✅ product-feature-guide mutations: ${total}/${total} 검출 (복원 후 baseline GREEN 재확인)`);
}

main();
