/**
 * Known extraction erratum in the 2026 KBO rulebook corpus.
 *
 * Original PDF p92 (printed p68), 보칙: this list identifies the base occupied
 * when interference occurred. Each referenced rule still decides the out or
 * advance award (5.09(b)(3), PDF p80; 5.05(b)(3), PDF p54). The v2 extractor
 * inherited a running 5.09 아웃 header and a wrong #p72 section locator.
 * Only the identified tier1 ebook fragment is repaired; no answer is rewritten,
 * no source is promoted, and stored corpus/embeddings remain unchanged.
 */
interface OfficialRuleContextRow {
  content: string;
  pageTitle: string;
  sectionPath: string;
  sourceGrade: string;
  sourceKind?: string;
}

const RETURN_BASE_SECTION = "보칙 — 방해 발생 시 주자의 귀루 기준";
const RETURN_BASE_CONTEXT = "각 항목의 아웃·진루 효과는 인용 조항을 따릅니다. 주자의 고의 송구방해는 아웃, 포수의 타격방해는 타자의 진루권에 관한 규정입니다.";

export function repairKnownOfficialRuleContext<T extends OfficialRuleContextRow>(
  row: T,
  maxContentChars: number,
): T {
  if (row.sourceGrade !== "tier1" || row.sourceKind !== "kbo_ebook") return row;
  if (row.pageTitle.replace(/\s/gu, "") !== "2026공식야구규칙") return row;
  if (!/^\s*5\s*\.\s*09\s*아\s*웃\s*\(이어짐\)/u.test(row.content)) return row;
  const compact = row.content.replace(/\s/gu, "");
  // The conjunction of these clauses fingerprints the mislabelled appendix.
  // A mention of interference in a genuine 5.09 out provision is not enough.
  if (!compact.includes("포수또는다른야수가타자의타격을방해하였을경우")
      || !compact.includes("주자가고의로송구를방해하였을경우")
      || !compact.includes("공격측선수또는코치가필요에따라자기가점유하고있는장소를양보하지않고")) return row;
  // Begin at a complete clause, not the dangling tail of the preceding item.
  // Remove the next page's running header, not any operative rule text.
  const clauseStart = row.content.search(/⒝\s*포수\s*또는\s*다른\s*야수가/u);
  if (clauseStart < 0) return row;
  const body = row.content.slice(clauseStart)
    .replace(/선수교체\s*[·ㆍ]\s*마운드\s*방문\s*5\s*\.\s*10\s*/u, "")
    .trim();
  const context = `${RETURN_BASE_SECTION}\n${RETURN_BASE_CONTEXT}`;
  const rendered = `${context}\n${body}`;
  return {
    ...row,
    sectionPath: RETURN_BASE_SECTION,
    // Never publish a half-cut clause/effect. The known 804-character source
    // fits whole after removing the broken prefix/running header. If a changed
    // source or smaller budget does not fit, retain only complete context.
    content: rendered.length <= maxContentChars ? rendered : context.length <= maxContentChars ? context : "",
  };
}
