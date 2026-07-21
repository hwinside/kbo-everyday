const WINDOW_MS = 60_000;
const MAX_REQUESTS = 30;
const MAX_KEYS = 5000;
const requests = new Map<string, number[]>();

/** 서버리스 인스턴스 단위 best-effort 폭주 방지. DB의 unique key가 중복 생성도 별도 차단한다. */
export function allowNewsDiscussionRequest(key: string, now = Date.now()): boolean {
  const recent = (requests.get(key) ?? []).filter((at) => now - at < WINDOW_MS);
  if (recent.length >= MAX_REQUESTS) {
    requests.set(key, recent);
    return false;
  }
  recent.push(now);
  requests.set(key, recent);

  if (requests.size > MAX_KEYS) {
    const oldestKeys = [...requests.keys()].slice(0, Math.floor(MAX_KEYS / 2));
    for (const oldKey of oldestKeys) requests.delete(oldKey);
  }
  return true;
}
