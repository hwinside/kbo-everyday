// ===== Streak contradiction guard =====
// LLM(Gemini)이 "롯데도 KT에 패했지만 3연승을 이어갔다"처럼 실제 승패/데이터와 모순되는
// 연승·연패 문장을 지어내는 사례(2026-07-25 하린아빠 리포트)를 결정론적으로 검출한다.
// sanitizeCopy(시점어 제거)와 달리 이 가드는 저장 전에 문장을 검증해 재생성/제거를 트리거한다.
//
// supabase 등 부수효과 있는 모듈에서 분리해 순수 함수만 두었다(유닛 테스트 격리 목적).
import type { StandingsSnapshot } from "@/lib/analysis/daily-delta";

export interface StreakFact {
  dir: "W" | "L";
  count: number;
}

// 스냅샷 streak 문자열("8연패"/"3연승"/"무"/"-")을 프롬프트용 라벨("8연패 중"/"3연승 중"/"")로 렌더.
// 방향은 반드시 문자열 내용으로 판정한다 — parseInt 부호에 의존하면 parseInt("8연패")=8(양수)라
// 실제 연패가 "연승"으로 뒤집혀 프롬프트가 거짓 데이터를 LLM에 먹인다(2026-07-25 원천 버그).
// 3연승/3연패 미만이거나 연속기록이 없으면 빈 문자열(프롬프트 미노출).
export function renderStreakLabel(streak: string | null): string {
  const s = streak || "";
  const count = parseInt(s.match(/(\d+)/)?.[1] || "0", 10);
  const dir = s.includes("연패") ? "연패" : s.includes("연승") ? "연승" : "";
  return dir && count >= 3 ? `${count}${dir} 중` : "";
}

// 스냅샷 streak 문자열("3연승"/"2연패"/"무"/"-")을 팀명 → {방향, 횟수}로 매핑.
// 데이터가 곧 진실이므로 |count|>=3 여부와 무관하게 전부 담아 방향/횟수 대조에 쓴다.
export function buildStreakFacts(
  snapshots: StandingsSnapshot[],
  teamNames: Map<number, string>,
): Map<string, StreakFact> {
  const facts = new Map<string, StreakFact>();
  for (const s of snapshots) {
    const name = teamNames.get(s.team_id);
    if (!name) continue;
    const str = s.streak ?? "";
    const m = str.match(/(\d+)/);
    if (!m) continue; // "무"/"-"/빈값은 연속기록 없음
    const count = parseInt(m[1], 10);
    if (str.includes("연승")) facts.set(name, { dir: "W", count });
    else if (str.includes("연패")) facts.set(name, { dir: "L", count });
  }
  return facts;
}

// 본문을 문장 단위로 분리(한국어 기사체 "~다." 종결 + 개행 기준).
export function splitSentences(copy: string): string[] {
  return copy
    .split(/(?<=[.!?。])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// 절 안에서 해당 팀이 streak의 *주어(연속기록 보유 주체)*인지 조사로 판정.
// "롯데도 KT에 패했지만 8연승"에서 롯데(도)는 주체, KT(에)는 상대팀이다.
// 주제/주격 조사가 붙은 팀만 streak 소유자 후보로 보아, 상대팀(KT에/를/을 등)이
// 대신 가짜 주장을 만족시키는 false-negative를 막는다.
const SUBJECT_PARTICLE_RE = /^(?:은|는|이|가|도|까지|만|역시|마저)/;
function hasSubjectParticle(clauseText: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const idx = clauseText.indexOf(name, from);
    if (idx < 0) return false;
    const after = clauseText.slice(idx + name.length);
    if (SUBJECT_PARTICLE_RE.test(after)) return true;
    from = idx + name.length;
  }
}

// 우리 분석 데이터는 단일일 delta만 제공한다 — "N년 만"/"N년만에" 같은 다년 이력 주장은
// 원리적으로 근거가 없는 Gemini 환각(2026-07-25 "8년 만" 리포트)이므로 결정론적으로 차단한다.
const YEAR_FABRICATION_RE = /(?:몇|\d+)\s*년\s*만/;
export function sentenceFabricatesYears(sentence: string): boolean {
  return YEAR_FABRICATION_RE.test(sentence);
}

// 문장을 절(clause) 단위 기준 오프셋 범위로 분리(콤마 기준).
// 콤마로 이어붙은 "SSG… 3연승, 롯데도… 3연승"에서 앞 절의 정상 주장이
// 뒤 절의 가짜 주장을 가리지 않도록, 각 절을 독립 검증하기 위함.
function clauseRanges(sentence: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = [];
  let start = 0;
  for (let i = 0; i < sentence.length; i++) {
    if (sentence[i] === "," || sentence[i] === "，") {
      ranges.push({ start, end: i });
      start = i + 1;
    }
  }
  ranges.push({ start, end: sentence.length });
  return ranges;
}

// 한 문장이 연승/연패 데이터와 모순되면 true.
// 규칙: 각 "N연승"/"N연패" 주장을 그 주장이 속한 *절*의 팀으로 먼저 검증.
//   - 절 안에 팀명이 있으면 그 팀들 중 최소 1팀이 데이터상 동일 방향·횟수여야 함.
//   - 절 안에 팀명이 없으면(주어 생략) 문장 전체 팀으로 폴백 검증(FP 방지).
// 어느 쪽도 안 맞으면 데이터에 근거 없는 창작/모순 → true.
export function sentenceContradictsStreak(
  sentence: string,
  facts: Map<string, StreakFact>,
  teamNames: string[],
): boolean {
  // 다년 이력 환각("N년 만")은 데이터 근거 자체가 없는 창작 → 무조건 모순 처리.
  if (sentenceFabricatesYears(sentence)) return true;
  const claims = [...sentence.matchAll(/(\d+)\s*연(승|패)/g)];
  if (claims.length === 0) return false;
  const sentenceTeams = teamNames.filter((n) => sentence.includes(n));
  const ranges = clauseRanges(sentence);
  for (const c of claims) {
    const count = parseInt(c[1], 10);
    const dir: "W" | "L" = c[2] === "승" ? "W" : "L";
    const idx = c.index ?? 0;
    const range = ranges.find((r) => idx >= r.start && idx < r.end) ?? { start: 0, end: sentence.length };
    const clauseText = sentence.slice(range.start, range.end);
    const clauseTeams = teamNames.filter((n) => clauseText.includes(n));
    // 주어 귀속: 주제/주\uaꢴ 조사가 붙은 팀이 있으면 그 팀만 streak 주체로 본다.
    // (상대팀 "KT에 패했지만"의 KT가 가짜 주장을 만족시키는 것을 차단).
    const subjectTeams = clauseTeams.filter((n) => hasSubjectParticle(clauseText, n));
    const scope = subjectTeams.length > 0
      ? subjectTeams
      : clauseTeams.length > 0
        ? clauseTeams
        : sentenceTeams;
    const matched = scope.some((n) => {
      const f = facts.get(n);
      return f !== undefined && f.dir === dir && f.count === count;
    });
    if (!matched) return true;
  }
  return false;
}

// 본문 전체에서 모순 문장 존재 여부.
export function hasStreakContradiction(
  copy: string,
  snapshots: StandingsSnapshot[],
  teamNames: Map<number, string>,
): boolean {
  if (!copy) return false;
  const facts = buildStreakFacts(snapshots, teamNames);
  const names = [...teamNames.values()];
  return splitSentences(copy).some((s) => sentenceContradictsStreak(s, facts, names));
}

// 재생성해도 모순이 남으면 최후수단으로 모순 문장만 제거(나머지 서사는 보존).
export function stripContradictorySentences(
  copy: string,
  snapshots: StandingsSnapshot[],
  teamNames: Map<number, string>,
): string {
  if (!copy) return copy;
  const facts = buildStreakFacts(snapshots, teamNames);
  const names = [...teamNames.values()];
  const kept = splitSentences(copy).filter((s) => !sentenceContradictsStreak(s, facts, names));
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}
