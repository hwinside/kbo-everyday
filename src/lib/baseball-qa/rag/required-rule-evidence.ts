import type { RagEvidence } from "./retrieve";
import { kstSeasonOf } from "../stats/team-record";

/** A retrieved number is not itself a rule. Explicit policy questions must
 * have evidence for that policy's scope; record tables and exception-only
 * excerpts cannot license the answer. No rule value is hard-coded here. */
export interface RequiredRuleEvidence {
  kind: "innings" | "fa_general";
  season: number;
  competition?: "regular" | "postseason";
  query: string;
  unavailable: string;
}

export function requiredRuleEvidence(question: string, now: number): RequiredRuleEvidence | null {
  const q = question.normalize("NFKC").toLowerCase();
  const years = [...new Set(q.match(/(?:19|20)\d{2}/g) ?? [])];
  if (years.length > 1) return null;
  const season = years.length ? Number(years[0]) : kstSeasonOf(now);
  if (/(?:연장|이닝)/.test(q) && /몇\s*회|최대|한도/.test(q)
    && !/역대|최장|최다|기록|메이저|마이너|mlb|npb|고교|대학/.test(q)) {
    const competition = /포스트\s*시즌|가을야구|와일드카드|준플레이오프|플레이오프|한국\s*시리즈/.test(q) ? "postseason" : "regular";
    const label = competition === "regular" ? "정규시즌" : "포스트시즌";
    return { kind: "innings", season, competition,
      query: `${question}\n확인할 규정: ${season} KBO ${label} 경기 연장전 최대 이닝 한도`,
      unavailable: `${season} KBO ${label}의 최대 이닝을 확인할 규정 근거가 부족합니다. 과거 경기의 최장 기록이나 다른 대회의 연장 규정을 현재 한도로 대신 안내하지 않겠습니다.` };
  }
  if (/(?:^|[^a-z])fa(?:[^a-z]|$)|프리에이전트/.test(q) && /자격|조건|취득/.test(q)
    && !/해외|외국|복귀|재취득|다시|mlb|npb/.test(q)) {
    return { kind: "fa_general", season,
      query: `${question}\n확인할 규정: ${season} KBO 야구규약 일반 FA 자격 최초 취득 활동 정규시즌 인정 등록일수`,
      unavailable: "일반 FA 자격의 취득·시즌 인정 조건을 확인할 공식 근거를 충분히 확보하지 못했습니다. 해외 복귀 선수의 재취득 예외만으로 일반 선수의 자격을 설명할 수는 없습니다." };
  }
  return null;
}

export function selectRequiredRuleEvidence(rows: RagEvidence[], request: RequiredRuleEvidence): RagEvidence[] {
  return rows.filter((row) => {
    if (row.sourceGrade !== "tier1") return false;
    const title = row.pageTitle.replace(/\s/g, "");
    const years = title.match(/(?:19|20)\d{2}/g) ?? [];
    if (years.length !== 1 || Number(years[0]) !== request.season) return false;
    const text = row.content.replace(/\s/g, "");
    if (request.kind === "fa_general") {
      return title.includes("야구규약") && /FA|프리에이전트/i.test(text)
        && /자격.*취득|취득.*자격/.test(text)
        && /등록일|활동시즌|정규시즌.*활동/.test(text)
        && !/외국에진출|국내로복귀|자격을다시취득/.test(text);
    }
    if (!title.includes("리그규정") || !/연장|이닝/.test(text)) return false;
    // A page's publication year or a bare article number does not establish
    // its competition. Missing chapter context is insufficient evidence.
    return request.competition === "regular"
      ? /정규시즌/.test(text) && !/한국시리즈|포스트시즌|플레이오프|와일드카드/.test(text)
      : /한국시리즈|포스트시즌|플레이오프|와일드카드/.test(text);
  });
}
