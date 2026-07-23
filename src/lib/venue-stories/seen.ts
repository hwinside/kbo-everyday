/**
 * 직관 스토리 본/안 본 상태 (하린아빠 2026-07-23 21:52 지시 — 인스타와 동일).
 *
 * - 안 본 스토리: 빨간 테두리 + 트레이 좌측 전진배치
 * - 본 스토리: 회색 테두리, 뒤로
 * - 저장은 기기 로컬(localStorage) — 서버 스키마 변경 없음.
 *
 * 사용자 스코프 (삼순 #809 blocker):
 * - 저장 namespace를 `user.id` 기준으로 분리한다. 같은 기기에서 계정을 전환해도
 *   서로의 시청 이력이 섞이지 않는다.
 * - 비로그인 정책: 별도 "anon" namespace에 기록한다. 로그인하면 개인 스코프로
 *   전환되며 anon 이력은 승계하지 않는다(타 계정 이력 오염 방지가 우선).
 * - 기기 로컬 저장이므로 같은 계정의 다른 기기/브라우저와는 동기화되지 않는다
 *   (서버 저장/RLS가 필요한 제품 계약이 생기면 별도 트랙).
 *
 * 저장 구조: 사용자별 키(`venue-story-seen:v1:u:<userId>` / `...:anon`) 아래
 * 게임별 LRU(MAX_GAMES) + 게임당 id cap(MAX_IDS_PER_GAME)으로 무한 성장 방지.
 */

const STORAGE_PREFIX = "venue-story-seen:v1";
const MAX_GAMES = 20;
const MAX_IDS_PER_GAME = 300;

type SeenMap = Record<string, string[]>;

/** 사용자별 storage key. 비로그인(null/undefined/빈문자열)은 anon namespace. */
export function seenStorageKey(userId: string | null | undefined): string {
  return userId ? `${STORAGE_PREFIX}:u:${userId}` : `${STORAGE_PREFIX}:anon`;
}

function readMap(userId: string | null | undefined): SeenMap {
  try {
    const raw = localStorage.getItem(seenStorageKey(userId));
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

function writeMap(userId: string | null | undefined, map: SeenMap): void {
  try {
    localStorage.setItem(seenStorageKey(userId), JSON.stringify(map));
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

export function loadSeenIds(gameId: string, userId: string | null | undefined): Set<string> {
  return new Set(readMap(userId)[gameId] ?? []);
}

/** 본 스토리 기록(사용자 스코프). 게임 키는 LRU(최근 사용이 뒤)로 최대 MAX_GAMES개 유지. */
export function markStorySeen(
  gameId: string,
  storyId: string | number,
  userId: string | null | undefined,
): void {
  const map = readMap(userId);
  const ids = map[gameId] ?? [];
  const key = String(storyId);
  if (!ids.includes(key)) ids.push(key);
  // LRU: 현재 게임을 맨 뒤로 재삽입
  delete map[gameId];
  map[gameId] = ids.slice(-MAX_IDS_PER_GAME);
  const keys = Object.keys(map);
  for (let i = 0; i < keys.length - MAX_GAMES; i++) delete map[keys[i]];
  writeMap(userId, map);
}

/** 테스트용 내부 노출 */
export const _internal = { STORAGE_PREFIX, MAX_GAMES, MAX_IDS_PER_GAME };
