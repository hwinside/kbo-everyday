/**
 * 표시용 선수명 — 공백 분리된 등록명에서 마지막 토큰만 반환.
 *
 * 외국인 선수는 KBO 등록명이 "요니 치리노스" 같은 풀네임이지만
 * 중계·해설·UI에서는 성("치리노스")만 사용. 일본 선수도 KBO 관행상
 * given name("유토", "나츠키")으로 부르며, 마찬가지로 마지막 토큰을
 * 표시한다. 한국 선수는 공백이 없어 그대로 통과.
 */
export function formatPlayerDisplayName(name: string | null | undefined): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1];
}
