/**
 * Gemini API 키 해석 — 단일 고정 이름.
 *
 * CI/운영 표준 secret 이름은 **GEMINI_API_KEY_HERO** 하나로 고정한다.
 * (기본 `GEMINI_API_KEY` 프로젝트는 크레딧 소진(429) 확인됨 — 2026-06-05)
 *
 * 우선순위:
 *   1. env GEMINI_API_KEY_HERO   ← CI 가 주입하는 *유일한* 이름
 *   2. env GEMINI_API_KEY         ← 로컬 개발 편의 fallback (CI 미사용)
 *   3. ~/.zshrc export            ← 로컬 셸 fallback (CI 미사용)
 *
 * 운영 사고 방지: CI 워크플로는 GEMINI_API_KEY_HERO 만 set 한다. 코드가 보는 이름과
 * secret 이름이 항상 일치하도록 이 헬퍼 한 곳에서만 키를 읽는다.
 */

import fs from "fs";

export function getGeminiKey() {
  if (process.env.GEMINI_API_KEY_HERO) return process.env.GEMINI_API_KEY_HERO;
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY; // local-only fallback
  try {
    const rc = fs.readFileSync(`${process.env.HOME}/.zshrc`, "utf8");
    const m =
      rc.match(/^export GEMINI_API_KEY_HERO="?([^"\n]+)"?/m) ||
      rc.match(/^export GEMINI_API_KEY="?([^"\n]+)"?/m);
    return m ? m[1] : "";
  } catch {
    return "";
  }
}
