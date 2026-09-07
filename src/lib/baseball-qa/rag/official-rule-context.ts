/**
 * Known extraction erratum in the 2026 KBO rulebook corpus.
 *
 * Original PDF p92 (printed p68), 보칙: this list identifies the base occupied
 * when interference occurred, not a list of out conditions. The v2 extractor
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

const RETURN_BASE_SECTION = "보칙 — 방해 발생 순간의 점유 베이스로 되돌려 보내는 경우";
const RETURN_BASE_CONTEXT = "이 목록은 귀루 기준이며, 각 항목이 모두 아웃 사유라는 뜻은 아닙니다.";

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
  const body = row.content.replace(/^\s*5\s*\.\s*09\s*아\s*웃\s*\(이어짐\)\s*/u, "");
  return {
    ...row,
    sectionPath: RETURN_BASE_SECTION,
    content: `${RETURN_BASE_SECTION}\n${RETURN_BASE_CONTEXT}\n${body}`.slice(0, maxContentChars),
  };
}
