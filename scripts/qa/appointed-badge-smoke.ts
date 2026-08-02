#!/usr/bin/env node
/**
 * 임명제 배지(크보팬 회장) 계약 회귀.
 *
 * 2026-08-02 하린아빠 지시로 신설. 이 배지는 활동으로 달성할 수 없고 운영이 직접 부여한다.
 * 그래서 일반 수집형 배지와 계약이 다르다:
 *   ① 정의가 ALL_BADGES + ACTIVE_BADGE_IDS 양쪽에 있어야 BadgesTab 에 뜬다
 *      (한쪽만 있으면 DB 에 행이 있어도 화면에 안 나온다 = 이번 작업의 근본 이유)
 *   ② 미보유자에겐 아예 안 보여야 한다. 회색 칸으로 뿌리면 "이건 어떻게 받나요" CS 가 열리고,
 *      하단 "N개 획득 / M개 중" 분모를 아무도 채울 수 없게 된다.
 *   ③ 보유자에겐 보여야 한다.
 *   ④ 분자·분모가 같은 목록에서 나와야 한다(분모만 늘고 분자는 못 늘어나는 비대칭 금지).
 *
 * 검증력 증명: 결함주입 3종(ACTIVE 누락 / 임명제 등록 누락 / 분모 전역화)에서 RED 여야 한다.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTIVE_BADGE_IDS,
  ALL_BADGES,
  APPOINTED_BADGE_IDS,
  BADGES,
  BADGE_MAP,
  CATEGORY_LABELS,
  RARITY_COLORS,
  visibleBadgesFor,
} from "../../src/lib/constants/badges";

const BADGE_ID = "keubo-chairperson";
const tabPath = resolve(process.cwd(), "src/components/profile/BadgesTab.tsx");

let pass = 0;
const fails = [];
const check = (label, cond, extra = "") => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fails.push(label);
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ""}`);
  }
};

// ── ① 정의 존재 ─────────────────────────────────────────────────────────────
const def = ALL_BADGES.find((b) => b.id === BADGE_ID);
check("[정의] ALL_BADGES 에 크보팬 회장 존재", def != null);
check("[정의] ACTIVE_BADGE_IDS 에 등록(없으면 DB 행이 있어도 미표시)",
  ACTIVE_BADGE_IDS.has(BADGE_ID));
check("[정의] BADGES(활성 목록)에 포함", BADGES.some((b) => b.id === BADGE_ID));
check("[정의] BADGE_MAP 조회 가능(토스트·상세 경로)", BADGE_MAP[BADGE_ID] != null);

if (def) {
  check("[정의] name = 크보팬 회장", def.name === "크보팬 회장", def.name);
  check("[정의] icon = 🏛️", def.icon === "🏛️", def.icon);
  check("[정의] category = special", def.category === "special", def.category);
  check("[정의] rarity = legendary", def.rarity === "legendary", def.rarity);
  check("[정의] category 가 CATEGORY_LABELS 에 존재(미존재면 섹션이 통째로 안 그려짐)",
    Object.prototype.hasOwnProperty.call(CATEGORY_LABELS, def.category));
  check("[정의] rarity 가 RARITY_COLORS 에 존재",
    Object.prototype.hasOwnProperty.call(RARITY_COLORS, def.rarity));
}

// ── ② 임명제 등록 + 노출 규칙 ───────────────────────────────────────────────
check("[임명제] APPOINTED_BADGE_IDS 에 등록", APPOINTED_BADGE_IDS.has(BADGE_ID));

const none = new Set();
const holder = new Set([BADGE_ID]);
const visibleNone = visibleBadgesFor(none).map((b) => b.id);
const visibleHolder = visibleBadgesFor(holder).map((b) => b.id);

check("[노출] 미보유자에게는 안 보임", !visibleNone.includes(BADGE_ID));
check("[노출] 보유자에게는 보임", visibleHolder.includes(BADGE_ID));
check("[노출] 임명제 외 배지는 미보유자에게도 그대로 보임(회귀 방지)",
  visibleNone.length === BADGES.length - 1 && visibleHolder.length === BADGES.length,
  `none=${visibleNone.length} holder=${visibleHolder.length} all=${BADGES.length}`);

// 다른 배지가 실수로 임명제로 분류되지 않았는지(파운더는 초대코드로 획득 경로가 있다)
check("[범위] 파운더는 임명제로 분류되지 않음", !APPOINTED_BADGE_IDS.has("founder"));
check("[범위] 임명제 목록은 크보팬 회장 1건", APPOINTED_BADGE_IDS.size === 1,
  [...APPOINTED_BADGE_IDS].join(","));

// ── ③④ BadgesTab 배선 ──────────────────────────────────────────────────────
const tabSrc = readFileSync(tabPath, "utf8");
check("[배선] BadgesTab 이 visibleBadgesFor 를 사용", tabSrc.includes("visibleBadgesFor("));
check("[배선] 그리드가 전역 BADGES 를 직접 순회하지 않음",
  !/BADGES\.filter\(b => b\.category/.test(tabSrc));
check("[배선] 분모가 전역 BADGES.length 가 아님(분자·분모 비대칭 방지)",
  !tabSrc.includes("{BADGES.length}개 중"));
check("[배선] 분모가 visibleBadges 기준", tabSrc.includes("{visibleBadges.length}개 중"));
check("[배선] 분자도 visible 목록으로 필터", tabSrc.includes("visibleIds.has(b.badge_id)"));

console.log(fails.length === 0 ? `\nPASS — ${pass}/${pass}` : `\nFAIL ${fails.length} / exit 1`);
process.exit(fails.length === 0 ? 0 : 1);
