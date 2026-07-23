/**
 * 직관 스토리 본/안 본 상태 (하린아빠 2026-07-23 21:52 지시 — 인스타와 동일).
 *
 * - 안 본 스토리: 빨간 테두리 + 트레이 좌측 전진배치
 * - 본 스토리: 회색 테두리, 뒤로
 * - 저장은 기기 로컬(localStorage) — 서버 스키마 변경 없음. 단일 키에 게임별 LRU로
 *   보관해 저장소가 무한히 자라지 않게 한다.
 */

const STORAGE_KEY = "venue-story-seen:v1";
const MAX_GAMES = 20;
const MAX_IDS_PER_GAME = 300;

type SeenMap = Record<string, string[]>;

function readMap(): SeenMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: SeenMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: SeenMap): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* 저장 실패는 UX 편의 기능이므로 조용히 무시 */
  }
}

/** 안 본 스토리를 앞으로(좌측), 본 스토리를 뒤로. 각 그룹 내 기존 순서 유지(stable). */
export function orderBySeen<T extends { id: string | number }>(
  stories: readonly T[],
  seenIds: ReadonlySet<string>,
): T[] {
  const unseen: T[] = [];
  const seen: T[] = [];
  for (const s of stories) (seenIds.has(String(s.id)) ? seen : unseen).push(s);
  return [...unseen, ...seen];
}

export function loadSeenIds(gameId: string): Set<string> {
  return new Set(readMap()[gameId] ?? []);
}

/** 본 스토리 기록. 게임 키는 LRU(최근 사용이 뒤)로 최대 MAX_GAMES개 유지. */
export function markStorySeen(gameId: string, storyId: string | number): void {
  const map = readMap();
  const ids = map[gameId] ?? [];
  const key = String(storyId);
  if (!ids.includes(key)) ids.push(key);
  // LRU: 현재 게임을 맨 뒤로 재삽입
  delete map[gameId];
  map[gameId] = ids.slice(-MAX_IDS_PER_GAME);
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - MAX_GAMES; i++) delete map[keys[i]];
  writeMap(map);
}

/** 테스트용 내부 노출 */
export const _internal = { STORAGE_KEY, MAX_GAMES, MAX_IDS_PER_GAME };
