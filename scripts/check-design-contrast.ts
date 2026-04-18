/**
 * WCAG AA 대비 자동 검사 (T1.5.2)
 *
 * 실행: `npx tsx scripts/check-design-contrast.ts`
 * CI: package.json scripts 에 `"contrast-check": "tsx scripts/check-design-contrast.ts"` 추가 예정 (T1.5.3)
 *
 * 검사 대상: 11팀(neutral 포함) × 주요 fg/bg 조합.
 * 실패 (< 4.5 for normal, < 3.0 for large) 시 프로세스 exit 1.
 *
 * Spec: specs/design-v2-migration.md (v0.5) §5.2
 */

import { TEAMS, NEUTRAL_PALETTE } from "../src/design-v2/TEAMS";
import { teamPalette } from "../src/design-v2/team-palette";
import { contrastRatio, classify } from "../src/lib/design-v2/contrast";

interface Check {
  fg: string;
  bg: string;
  label: string;
  required: "AA" | "AA-large";
}

interface Result {
  team: string;
  label: string;
  fg: string;
  bg: string;
  ratio: number;
  level: string;
  required: string;
  pass: boolean;
}

function hexifyRgba(input: string): string {
  // team-palette withAlpha() 가 rgba(...) 를 반환하므로 contrast 계산 전 bg 와 블렌드 필요.
  // 단순화를 위해 rgba 는 알파 무시하고 underlying bg 위에 올려진 최종 색 근사.
  const m = input.match(/^rgba\((\d+),\s*(\d+),\s*(\d+),\s*([\d.]+)\)$/);
  if (!m) return input;
  const [, r, g, b, a] = m;
  const alpha = parseFloat(a);
  // bg0 위로 가정 (#07070A)
  const bgR = 0x07,
    bgG = 0x07,
    bgB = 0x0a;
  const fr = Math.round(parseInt(r) * alpha + bgR * (1 - alpha));
  const fg = Math.round(parseInt(g) * alpha + bgG * (1 - alpha));
  const fb = Math.round(parseInt(b) * alpha + bgB * (1 - alpha));
  return (
    "#" +
    [fr, fg, fb].map((x) => x.toString(16).padStart(2, "0")).join("")
  );
}

function runChecks(): Result[] {
  const results: Result[] = [];
  const slugs = Object.keys(TEAMS) as Array<keyof typeof TEAMS>;

  for (const slug of slugs) {
    const team = TEAMS[slug];
    const p = teamPalette(team);

    const checks: Check[] = [
      {
        label: "text-1 on bg-0",
        fg: "#f5f5f7",
        bg: NEUTRAL_PALETTE.bg0,
        required: "AA",
      },
      {
        label: "text-2 on bg-2",
        fg: "#adadb0",
        bg: NEUTRAL_PALETTE.bg2,
        required: "AA",
      },
      {
        label: "accent on bg-2 (큰 텍스트)",
        fg: p.accent,
        bg: NEUTRAL_PALETTE.bg2,
        required: "AA-large",
      },
      {
        label: "onAccent on accent (CTA)",
        fg: p.onAccent,
        bg: p.accent,
        required: "AA",
      },
      {
        label: "light on bg-2",
        fg: p.light,
        bg: NEUTRAL_PALETTE.bg2,
        required: "AA-large",
      },
      {
        label: "accent on cardTint",
        fg: p.accent,
        bg: hexifyRgba(p.cardTint),
        required: "AA-large",
      },
    ];

    for (const c of checks) {
      const fg = hexifyRgba(c.fg);
      const bg = hexifyRgba(c.bg);
      const ratio = contrastRatio(fg, bg);
      const level = classify(ratio);
      const pass =
        c.required === "AA"
          ? ratio >= 4.5
          : ratio >= 3.0;
      results.push({
        team: slug,
        label: c.label,
        fg,
        bg,
        ratio: Math.round(ratio * 100) / 100,
        level,
        required: c.required,
        pass,
      });
    }
  }

  return results;
}

function main() {
  const results = runChecks();
  const failed = results.filter((r) => !r.pass);
  const passed = results.filter((r) => r.pass);

  console.log(`\nWCAG Contrast Check — ${results.length} pairs tested\n`);
  console.log(`  Passed: ${passed.length}`);
  console.log(`  Failed: ${failed.length}\n`);

  if (failed.length > 0) {
    console.log("Failures:");
    for (const r of failed) {
      console.log(
        `  [${r.team}] ${r.label}  fg=${r.fg} bg=${r.bg}  ratio=${r.ratio}  required=${r.required}  got=${r.level}`,
      );
    }
    console.log("");
    process.exit(1);
  }

  console.log("All pairs pass AA or AA-large. ✅\n");
}

main();
