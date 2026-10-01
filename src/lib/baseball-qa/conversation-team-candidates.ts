/** A candidate is a whole server-tokenized word, not a model-written quote.
 * Alias occurrence proposes identity only; it is NOT evidence of a baseball club.
 * In particular, a company's whole name stays visible for semantic rejection. */
export interface ConversationTeamCandidate {
  id: string;
  source: "question" | "context_question";
  token: string;
  start: number;
  end: number;
  canonical: string;
}
export interface ConversationTeamAlias {
  canonical: string;
  shorts: readonly string[];
  nicks: readonly string[];
}
export function collectConversationTeamCandidates(
  question: string, contextQuestion: string | undefined,
  aliases: readonly ConversationTeamAlias[], resolve: (text: string) => string[],
): ConversationTeamCandidate[] {
  const result: ConversationTeamCandidate[] = [];
  const segmenter = new Intl.Segmenter("ko", { granularity: "word" });
  for (const source of ["question", "context_question"] as const) {
    const text = source === "question" ? question : contextQuestion;
    if (!text) continue;
    // ICU splits Latin/Korean script boundaries (LG + 전자) without a space.
    // Rejoin adjacent word segments so a company can never lose its suffix.
    const words: { token: string; start: number }[] = [];
    for (const part of segmenter.segment(text)) {
      if (!part.isWordLike) continue;
      const previous = words.at(-1);
      if (previous && previous.start + previous.token.length === part.index) previous.token += part.segment;
      else words.push({ token: part.segment, start: part.index });
    }
    for (const { token, start } of words) {
      const known = resolve(token);
      const normalized = token.normalize("NFKC").toLowerCase();
      for (const { canonical, shorts, nicks } of aliases) {
        if (known.includes(canonical)) continue;
        if (![...shorts, ...nicks].some((alias) => normalized.includes(alias))) continue;
        result.push({ id: `${source}:${start}:${canonical}`, source, token,
          start, end: start + token.length, canonical });
      }
    }
  }
  return result;
}

export const TEAM_CANDIDATE_PROMPT = `teamCandidates는 코드가 원문 전체 단어에서 만든 구단명 후보이며 확정 구단이 아닙니다. action=app_facts이면 target.mentions에는 조회 대상·제외·배경 역할에 실제 사용하는 후보 ID만 판정합니다. 사용하지 않는 후보는 생략하거나 unused로 둡니다. teamNames로 이미 확정된 구단에는 후보 ID를 만들지 않습니다. 후보 token 전체와 출처 문맥이 실제 야구 구단을 지칭할 때만 referent=baseball_team, 회사·상품·다른 고유명사는 non_team, 불확실하면 unknown입니다. 이름 일부만 보고 회사를 구단으로 쪼개지 않습니다. role은 target/excluded/background/unused입니다. non_team/unknown은 unused입니다. 직전 후보는 현재가 같은 야구 경기의 후속일 때만 target 등으로 사용하며 무관한 직전 주제는 unused입니다. 현재 명시한 구단은 직전 구단보다 우선합니다. 선택한 후보 canonical을 target의 해당 역할 배열에도 넣습니다. 후보 ID를 선택할 뿐 원문을 다시 쓰거나 띄어쓰기를 복원하지 않습니다. 후보 ID로만 구단 대상이 결속되고 구장 조건이 없으면 target.quote는 빈 문자열이어도 됩니다. 다른 action이나 후보가 없으면 mentions=[]입니다.`;

export const TEAM_MENTIONS_SCHEMA = { type: "ARRAY", items: { type: "OBJECT", properties: {
  id: { type: "STRING" }, referent: { type: "STRING", enum: ["baseball_team", "non_team", "unknown"] },
  role: { type: "STRING", enum: ["target", "excluded", "background", "unused"] },
}, required: ["id", "referent", "role"] } };

/** Only selected, non-lexical teams depend on candidate evidence. Unused or
 * invented mentions cannot invalidate an independently resolved request. */
export function bindConversationTeamCandidates(
  candidates: readonly ConversationTeamCandidate[], mentions: unknown,
  question: string, contextQuestion: string | undefined, source: unknown,
  lexicalNames: readonly string[], selected: Record<"target" | "excluded" | "background", string[]>,
): { question: string[]; context_question: string[]; roles: Record<string, string[]> } | null {
  const bound = { question: [] as string[], context_question: [] as string[],
    roles: { target: [] as string[], excluded: [] as string[], background: [] as string[] } };
  const rows = Array.isArray(mentions) ? mentions : [];
  for (const role of ["target", "excluded", "background"] as const) {
    for (const team of selected[role]) {
      if (lexicalNames.includes(team)) continue;
      if (source !== "question" && source !== "context_question") return null;
      const grounded = candidates.some((candidate) => {
        if (candidate.canonical !== team || candidate.source !== source) return false;
        const text = source === "question" ? question : contextQuestion;
        if (!text || text.slice(candidate.start, candidate.end) !== candidate.token) return false;
        const matches = rows.filter((row) => row && typeof row === "object" && row.id === candidate.id);
        return matches.length === 1 && matches[0].referent === "baseball_team" && matches[0].role === role;
      });
      if (!grounded) return null;
      bound[source].push(team);
      bound.roles[role].push(team);
    }
  }
  return bound;
}
