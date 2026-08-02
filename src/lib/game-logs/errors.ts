/**
 * 수비 실책(error) 선수별 파싱 — 하린아빠 2026-08-02 "발암경기 인내형" 태그 트랙.
 *
 * ⚠️ 배경(내 오보 정정): 나는 "실책 데이터가 없다"고 세 번 보고했지만 **틀렸다.**
 * KBO boxscore(`주요기록`)와 Naver record(`etcRecords`) 양쪽에 실책이 있고,
 * 우리 파서는 이미 같은 테이블에서 도루를 읽고 있었다. "우리 DB에 안 담는다"와
 * "수집 불가"는 다르다. 이 모듈은 그 구분을 코드로 남긴다.
 *
 * 소스 계약(실측):
 *   etcRecords: [{ how: "실책", result: "오지환2(7 8회)" }]
 *   scoreBoard.rheb: { away: { e: 2, ... }, home: { e: 0, ... } }
 *
 * 표기 형식(2026 실측 8경기):
 *   `이름(N회)`        → 1개
 *   `이름K(N M회)`     → K개  (예: `오지환2(7 8회)`)
 *   여러 명은 공백 구분 (예: `김웅빈2(2 7회) 서건창(4회)`)
 *
 * **fail-close 원칙**: 선수별 파싱 합계가 `rheb` 팀 실책 수와 **팀 단위로 정확히
 * 일치할 때만** 채택한다. 하나라도 어긋나면 그 경기는 실책 미상(null)으로 둔다.
 * 실책은 "발암경기" 태그의 근거라 과소·과대 모두 유저에게 거짓말이 된다.
 */

/** 한 경기의 실책 파싱 결과. `null` 은 "이 경기는 실책을 알 수 없음"(0 아님). */
export interface GameErrorRecord {
  /** 선수명 → 실책 수. 검증 통과분만 담긴다. */
  byPlayerName: Map<string, number>;
  /** 원정팀 실책 총계(공식 rheb). */
  awayTotal: number;
  /** 홈팀 실책 총계(공식 rheb). */
  homeTotal: number;
}

/**
 * `실책` 문자열 → 선수명별 개수.
 *
 * 이름은 한글/영문(외국인 선수 표기)만 허용하고, 반드시 `(...회)` 가 붙어야 한다.
 * `(...)` 없는 토큰을 이름으로 인정하면 심판명·주석이 섞여 들어온다.
 */
export function parseErrorText(text: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const s = typeof text === "string" ? text : "";
  if (!s.trim()) return out;
  // `이름` + (선택)`개수` + `(이닝 ...회)`
  const pattern = /([가-힣A-Za-z][가-힣A-Za-z.\s]*?)(\d*)\((\d+(?:\s+\d+)*)회\)/g;
  for (const m of s.matchAll(pattern)) {
    const name = m[1]!.trim();
    if (!name) continue;
    const explicit = m[2] ? Number.parseInt(m[2], 10) : null;
    const innings = m[3]!.trim().split(/\s+/).filter(Boolean).length;
    // 개수 표기가 있으면 그 값, 없으면 이닝 나열 수(대개 1).
    const count = explicit != null && Number.isFinite(explicit) ? explicit : innings;
    if (!Number.isFinite(count) || count <= 0) continue;
    out.set(name, (out.get(name) ?? 0) + count);
  }
  return out;
}

/**
 * `rheb` 팀 실책 수 strict 파싱 — 결측/비숫자는 null(0 강등 금지).
 *
 * ⚠️ 자가신고: 첫 구현이 `Number(raw)` 만 썼는데 **`Number("") === 0`** 이라
 * 빈 문자열이 "실책 0개"로 통과했다. 같은 날 `time` 결손 오분류(00시=낮경기)와
 * **정확히 같은 함정**이고, 내가 그걸 고친 직후에 또 냈다. 회귀가 즉시 잡았다.
 * 문자열은 공백 제거 후 비어 있으면 결측으로 본다.
 */
export function parseTeamErrorTotal(rheb: unknown, side: "away" | "home"): number | null {
  const box = (rheb as Record<string, unknown> | null | undefined)?.[side];
  const raw = (box as Record<string, unknown> | null | undefined)?.e;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "boolean") return null;
  if (typeof raw === "string" && raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

/**
 * 선수별 실책을 **팀 단위 공식 합계와 대조**해 채택 여부를 결정한다.
 *
 * `resolveTeam` 은 선수명 → "away" | "home" | null(미상). 로스터로 판정한다.
 * 미상이 하나라도 있으면 팀 배분을 확정할 수 없으므로 전체 fail-close.
 */
export function reconcileGameErrors(input: {
  errorText: unknown;
  rheb: unknown;
  resolveTeam: (playerName: string) => "away" | "home" | null;
}): GameErrorRecord | null {
  const awayTotal = parseTeamErrorTotal(input.rheb, "away");
  const homeTotal = parseTeamErrorTotal(input.rheb, "home");
  // 공식 팀 합계가 없으면 대조 자체가 불가능 → 미상.
  if (awayTotal === null || homeTotal === null) return null;

  const parsed = parseErrorText(input.errorText);

  // 실책 0 경기 — 공식 합계도 0이고 파싱도 비어야 정합.
  if (awayTotal === 0 && homeTotal === 0) {
    if (parsed.size > 0) return null; // 모순 → 미상
    return { byPlayerName: new Map(), awayTotal: 0, homeTotal: 0 };
  }

  let awaySum = 0;
  let homeSum = 0;
  for (const [name, count] of parsed) {
    const side = input.resolveTeam(name);
    if (side === null) return null; // 팀 미상 → 배분 불가 → 전체 fail-close
    if (side === "away") awaySum += count;
    else homeSum += count;
  }
  // 팀 단위 exact 대조 — 합계만 맞고 배분이 틀린 경우를 걸러낸다.
  if (awaySum !== awayTotal || homeSum !== homeTotal) return null;

  return { byPlayerName: parsed, awayTotal, homeTotal };
}

/** Naver record `recordData` 에서 실책 문자열 추출. 없으면 빈 문자열(≠ 미상). */
export function extractErrorText(etcRecords: unknown): string {
  if (!Array.isArray(etcRecords)) return "";
  for (const entry of etcRecords) {
    const how = (entry as Record<string, unknown> | null)?.how;
    if (typeof how === "string" && how.trim() === "실책") {
      const result = (entry as Record<string, unknown>).result;
      return typeof result === "string" ? result : "";
    }
  }
  return "";
}
