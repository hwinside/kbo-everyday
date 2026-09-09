import type { RagEvidence } from "./retrieve";
import { kstSeasonOf } from "../stats/team-record";

/** A retrieved number is not itself a rule. Explicit policy questions must
 * have evidence for that policy's scope; record tables and exception-only
 * excerpts cannot license the answer. No rule value is hard-coded here. */
export interface RequiredRuleEvidence {
  kind: "innings" | "fa_general" | "postseason_entry";
  season: number;
  competition?: "regular" | "postseason";
  faFocus?: "general" | "graduate" | "registration";
  query: string;
  unavailable: string;
}

export type RequiredRuleRequest = Pick<RequiredRuleEvidence, "kind" | "season" | "competition" | "faFocus"> & { fact?: RequiredRuleFact };

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
  if (/(?:^|[^a-z])fa(?:[^a-z]|$)|프리\s*에이전트/.test(q) && /자격|조건|취득|몇\s*(?:년|시즌)|등록\s*일|며칠|일수/.test(q)
    && !/해외|외국|복귀|재취득|다시|mlb|npb/.test(q)) {
    const faFocus = /등록\s*일|며칠|일수/.test(q) ? "registration"
      : /대졸|대학|4\s*년제/.test(q) ? "graduate" : "general";
    const target = faFocus === "registration" ? "제162조 제2항 제3호 현역선수 등록일수 정규시즌 인정 단서"
      : faFocus === "graduate" ? "제162조 제5항 4년제 대학 졸업 선수 FA자격 활동 정규시즌 단축"
      : "제162조 제1항 최초 FA자격 취득 활동 정규시즌 시즌 종료 후";
    return { kind: "fa_general", season, faFocus,
      query: `${question}\n확인할 규정: ${season} KBO 야구규약 ${target}`,
      unavailable: "일반 FA 자격의 취득·시즌 인정 조건을 확인할 공식 근거를 충분히 확보하지 못했습니다. 해외 복귀 선수의 재취득 예외만으로 일반 선수의 자격을 설명할 수는 없습니다." };
  }
  // Qualification RULES, not a named club's live standing/probability.
  if (/포스트\s*시즌|가을야구/.test(q) && /몇\s*위|상위\s*몇|진출\s*(?:기준|조건)/.test(q)
    && !/확률|가능성|예상|올라갈|진출할|오늘|내일|mlb|npb|메이저|일본/.test(q)) {
    return { kind: "postseason_entry", season, competition: "postseason",
      query: `${question}\n확인할 규정: ${season} KBO 리그 규정 제30조 와일드카드 결정전 정규시즌 승률 순위 참가 구단`,
      unavailable: `${season} KBO 포스트시즌 진출 순위 기준을 확인할 공식 근거가 부족합니다. 현재 구단 순위나 다른 대회의 기준으로 대신 답하지 않겠습니다.` };
  }
  return null;
}

export function selectRequiredRuleEvidence(rows: RagEvidence[], request: RequiredRuleEvidence): RagEvidence[] {
  const selected = rows.filter((row) => {
    if (row.sourceGrade !== "tier1") return false;
    const title = row.pageTitle.replace(/\s/g, "");
    const years = title.match(/(?:19|20)\d{2}/g) ?? [];
    if (years.length !== 1 || Number(years[0]) !== request.season) return false;
    const text = row.content.replace(/\s/g, "");
    const citation = row.sectionPath.replace(/\s/g, "");
    // Verified supplements preserve a chapter + exact article citation in
    // sectionPath and copy that same heading into the evidence text. A clause
    // may legitimately compare two competitions or include historical rules;
    // those words alone must not reject the correctly scoped primary clause.
    const headed = row.content.startsWith(row.pageTitle + " / ") && text.includes(citation.split("#").slice(1).join("#"));
    if (request.kind === "fa_general") {
      const generalArticle = citation.endsWith("#제17장프리에이전트(FA)>제162조[FA자격요건]")
        || citation.endsWith("#제17장프리에이전트(FA)>제163조[기록의합산]");
      if (title.includes("야구규약") && headed && generalArticle) return true;
      return title.includes("야구규약") && /FA|프리에이전트/i.test(text)
        && /자격.*취득|취득.*자격/.test(text)
        && /등록일|활동시즌|정규시즌.*활동/.test(text)
        && !/외국에진출|국내로복귀|자격을다시취득/.test(text);
    }
    if (request.kind === "postseason_entry") {
      return title.includes("리그규정") && headed
        && /#제[2-5]장[^#]*>제(?:30|34|38|42)조/.test(citation);
    }
    if (!title.includes("리그규정") || !/연장|이닝/.test(text)) return false;
    if (request.competition === "regular" && headed
      && citation.endsWith("#제1장KBO정규시즌>제1조경기방식")) return true;
    // A page's publication year or a bare article number does not establish
    // its competition. Missing chapter context is insufficient evidence.
    return request.competition === "regular"
      ? /정규시즌/.test(text) && !/한국시리즈|포스트시즌|플레이오프|와일드카드/.test(text)
      : /한국시리즈|포스트시즌|플레이오프|와일드카드/.test(text);
  });
  // The primary answer clause must survive selectEvidence's bounded top-N.
  // Preserve the original text and historical provisos; only order changes.
  const priority = (row: RagEvidence) => {
    if (request.kind === "fa_general") return faPrimaryClause(row, request) ? 0 : 1;
    if (request.kind === "postseason_entry") return /제30조/.test(row.sectionPath) ? 0 : 1;
    return 0;
  };
  return selected.sort((a, b) => priority(a) - priority(b));
}

function faPrimaryClause(row: RagEvidence, request: RequiredRuleEvidence): boolean {
  const citation = row.sectionPath.replace(/\s/g, "");
  const marker = request.faFocus === "registration" ? "②" : request.faFocus === "graduate" ? "⑤" : "①";
  return citation.endsWith("#제17장프리에이전트(FA)>제162조[FA자격요건]")
    && row.content.startsWith(row.pageTitle + " / ")
    && row.content.split("\n").slice(1).join("\n").trimStart().startsWith(marker);
}

export interface RequiredRuleFact {
  value: string;
  unit: "시즌" | "일";
  effectiveYear: number;
  quote: string;
}

/** Extract the operative proviso from retrieved, sanitized, current-edition
 * evidence. Never fill missing evidence using hard-coded eligibility values. */
export function requiredRuleFact(rows: RagEvidence[], request: RequiredRuleEvidence): RequiredRuleFact | null {
  if (request.kind !== "fa_general") return null;
  const facts = rows.filter((row) => faPrimaryClause(row, request)).flatMap((row) => {
    const text = row.content.replace(/\s/g, "");
    const registration = request.faFocus === "registration";
    const pattern = registration ? /(\d{4})년정규시즌부터는(\d+)일이상/
      : request.faFocus === "graduate" ? /(\d{4})년시즌종료후부터(\d+)정규시즌으로단축/
      : /(\d{4})년시즌종료후부터는(\d+)정규시즌/;
    const m = text.match(pattern);
    if (!m || Number(m[1]) > request.season) return [];
    return [{ value: m[2], unit: registration ? "일" as const : "시즌" as const,
      effectiveYear: Number(m[1]), quote: m[0] }];
  });
  // Conflicting clauses are not resolved by whichever vector happens to rank first.
  return facts.length && facts.every((f) => f.value === facts[0].value && f.effectiveYear === facts[0].effectiveYear) ? facts[0] : null;
}
