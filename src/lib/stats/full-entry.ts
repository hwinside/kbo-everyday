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

/**
 * 전체 엔트리(full=1): 라이브 리더보드(규정타석/이닝 위주)에 없는 선수를
 * 매일 CI 크롤한 전체 JSON에서 채워 넣는다. 라이브 선수는 실시간 값을 유지하고
 * 비규정(백업) 선수만 추가 → 기록실 전용. 다른 화면은 full 없이 규정 리더보드 그대로.
 *
 * dedup 규칙(중복 노출 방지 + 동명이인 보존):
 *  1) canonical kboId 기준. 외국인은 라이브=영문ID·크롤=숫자ID로 갈리므로
 *     FOREIGN_NUMERIC_TO_ALPHA로 정규화해 한 선수로 모은다.
 *  2) 라이브에서 ID 미해결(빈 kboId, 주로 외국인)인 선수는 크롤이 숫자ID로 들고 있어
 *     id-key가 어긋남 → 그 name::team을 별도로 막아 중복 차단.
 *  3) 서로 다른 숫자ID 동명이인(예: 삼성 이승현 2명)은 정규화 대상이 아니라 그대로 보존.
 *  4) 크롤 JSON 자체의 동일 ID 중복도 append 중 dedup으로 1건만 남긴다.
 */
export function mergeFullEntry<T extends FullEntryRow>(live: T[], crawled: T[]): T[] {
  const keyOf = (p: T): string => {
    const id = canonId(p.kboId);
    return id ? `id:${id}` : `nt:${p.name}::${p.team}`;
  };
  const seen = new Set(live.map(keyOf));
  const liveUnresolvedNT = new Set(
    live.filter((p) => !canonId(p.kboId)).map((p) => `${p.name}::${p.team}`),
  );
  const out: T[] = [...live];
  for (const p of crawled) {
    const k = keyOf(p);
    if (seen.has(k) || liveUnresolvedNT.has(`${p.name}::${p.team}`)) continue;
    seen.add(k);
    out.push({ ...p, qualifiedRate: typeof p.qualifiedRate === "number" ? p.qualifiedRate : 0 });
  }
  return out;
}
