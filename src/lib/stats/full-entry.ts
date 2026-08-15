import { canonicalKboId } from "@/lib/utils/resolve-player";

/** 전체 엔트리 병합 대상 최소 형태 (라이브/크롤 스탯 공통). */
export type FullEntryRow = {
  name: string;
  team: string;
  kboId?: string | number;
  qualifiedRate?: number;
  [k: string]: unknown;
};

/** 외국인 숫자ID(56251) → canonical 영문ID(FP009). 비외국인/빈값은 그대로.
 * (정규화는 resolve-player의 canonicalKboId 경유 — foreign-id-map 직접 import 금지 룰) */
const canonId = (id: string | number | undefined): string => canonicalKboId(id);

/**
 * full=1 응답은 live + static(비규정 엔트리) + runner 보정의 혼합물이다. 응답 freshness는
 * `now`가 아니라 **가장 오래된 구성요소 시각**이어야 stale 가드가 우회되지 않는다.
 */
export class StatsFreshnessContractError extends Error {
  constructor(message = "stats response has invalid component freshness") {
    super(message);
    this.name = "StatsFreshnessContractError";
  }
}

export function oldestFullEntryTimestamp(
  values: readonly (string | null | undefined)[],
  now = new Date(),
): string | null {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return null;
  const parsed = values.map((value) => ({
    value,
    ms: typeof value === "string" ? Date.parse(value) : Number.NaN,
  }));
  // min을 먼저 계산하면 [정상 now, 미래 static]에서 정상 now가 선택돼 오염이 숨는다.
  // 구성요소 **전부**를 먼저 검증한 뒤 가장 오래된 시각을 고른다(5분 clock skew만 허용).
  if (
    parsed.length === 0 ||
    parsed.some((item) => typeof item.value !== "string" || !Number.isFinite(item.ms) || item.ms > nowMs + 5 * 60_000)
  ) return null;
  return parsed.reduce((oldest, item) => item.ms < oldest.ms ? item : oldest).value as string;
}

export function requireOldestFullEntryTimestamp(
  values: readonly (string | null | undefined)[],
  now = new Date(),
): string {
  const value = oldestFullEntryTimestamp(values, now);
  if (!value) throw new StatsFreshnessContractError();
  return value;
}

/**
 * 전체 엔트리(full=1): 라이브 리더보드(규정타석/이닝 위주)에 없는 선수를
 * 매일 CI 크롤한 전체 JSON에서 채워 넣는다. 라이브 선수는 실시간 값을 유지하고
 * 비규정(백업) 선수만 추가 → 기록실 전용. 다른 화면은 full 없이 규정 리더보드 그대로.
 *
 * identity 계약(삼순 #1196 3차 P0-1 — canonical ID-only, 혼합/보조키 없음):
 *  1) 모든 행은 canonical kboId 보유가 전제다. 결손은 `name::team` 보조키로
 *     흡수하지 않고 **throw** 한다(보조키 자체가 동명이인 오염 경로였다).
 *     외국인 영문/숫자 이중 ID 는 FOREIGN_NUMERIC_TO_ALPHA 정규화로 한 선수로 모은다.
 *  2) live 내 중복·crawled 내 중복은 조용한 dedupe 가 아니라 **throw** (소스 오염).
 *  3) live↔crawled 같은 ID 는 정상(같은 선수) — 단 name 이 다르면 식별 충돌로 **throw**.
 *     (team 은 이적 당일 live/static 시점차로 정당하게 갈릴 수 있어 충돌 판정에서 제외,
 *      name 까지 다르면 같은 ID 가 다른 사람을 가리키는 오염이다.)
 *  4) 서로 다른 숫자ID 동명이인(예: 삼성 이승현 2명)은 각자 ID 로 그대로 보존된다.
 * 위반 시 throw → 호출측(GET)이 전체 fallback 으로 닫는다.
 */
export function mergeFullEntry<T extends FullEntryRow>(live: T[], crawled: T[]): T[] {
  const liveById = new Map<string, T>();
  for (const p of live) {
    const id = canonId(p.kboId);
    if (!id) throw new Error(`full-entry identity missing (live): ${p.name}::${p.team}`);
    if (liveById.has(id)) throw new Error(`full-entry identity duplicated (live): ${id}`);
    liveById.set(id, p);
  }
  const crawledSeen = new Set<string>();
  const out: T[] = [...live];
  for (const p of crawled) {
    const id = canonId(p.kboId);
    if (!id) throw new Error(`full-entry identity missing (crawled): ${p.name}::${p.team}`);
    if (crawledSeen.has(id)) throw new Error(`full-entry identity duplicated (crawled): ${id}`);
    crawledSeen.add(id);
    const existing = liveById.get(id);
    if (existing) {
      // 같은 선수 — 라이브 실시간 행 유지. name 불일치는 식별 체계 오염이다.
      if (existing.name.trim() !== p.name.trim()) {
        throw new Error(`full-entry identity conflict: ${id}`);
      }
      continue;
    }
    out.push({ ...p, qualifiedRate: typeof p.qualifiedRate === "number" ? p.qualifiedRate : 0 });
  }
  return out;
}
