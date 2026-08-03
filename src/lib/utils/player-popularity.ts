/**
 * 선수 목록 정렬 — 최애선수로 지정한 계정 수 내림차순, 동률은 가나다순.
 *
 * 온보딩(PlayerSelectModal)의 팀 탭·전체 탭·검색 결과 전부 같은 기준을 쓴다.
 * 순수 함수로 분리해 UI 없이 계약을 검증할 수 있게 한다.
 */

export type PopularityCounts = Record<string, number>;

interface SortablePlayer {
  id: string;
  name: string;
}

/**
 * 인기순 정렬. 원본 배열은 건드리지 않는다.
 *
 * - 지정 계정 수 내림차순
 * - 동률(0명끼리 포함)은 이름 가나다순 — 순서가 실행마다 흔들리면 안 된다
 * - counts 가 비어 있으면(집계 실패·미로딩) 전원 0 이 되어 자연스럽게 가나다순이 된다
 */
export function sortPlayersByPopularity<T extends SortablePlayer>(
  players: readonly T[],
  counts: PopularityCounts,
): T[] {
  return [...players].sort((a, b) => {
    const diff = (counts[b.id] ?? 0) - (counts[a.id] ?? 0);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "ko");
  });
}

/**
 * API 응답을 정규화한다.
 *
 * playerId 는 DB 에서 jsonb string 으로 저장되지만 number 가 섞여도 깨지지 않게
 * 문자열로 통일하고, 음수·NaN·0 은 버린다(0 은 어차피 기본값이라 담을 이유가 없다).
 */
export function normalizePopularityCounts(raw: unknown): PopularityCounts {
  if (!raw || typeof raw !== "object") return {};
  const out: PopularityCounts = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const id = String(key).trim();
    if (!id) continue;
    const n = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(n) || n <= 0) continue;
    out[id] = n;
  }
  return out;
}
