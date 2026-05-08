// Naver record API populates `hit` per batter but leaves `h2`/`h3` null and
// frequently reports `hr=0` for live games, so 2루타/3루타/홈런이 단타로
//뭉개진다. textRelayData에는 결과 문자열이 정확히 남아있어서 거기서 카운트를
// 보강한다.

const NAVER_API = "https://api-gw.sports.naver.com/schedule/games";

const HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)",
};

interface NaverTextOption {
  text: string;
  type: number;
}

interface NaverTextRelay {
  title: string;
  titleStyle: string;
  textOptions?: NaverTextOption[];
}

interface NaverRelayResponse {
  result?: {
    textRelayData?: {
      inn?: number;
      textRelays?: NaverTextRelay[];
    };
  };
}

export interface BatterRelayCount {
  h2b: number;
  h3b: number;
  hr: number;
}

export function tallyHitsFromRelays(
  textRelays: NaverTextRelay[],
): Map<string, BatterRelayCount> {
  const counts = new Map<string, BatterRelayCount>();

  for (const relay of textRelays) {
    if (relay.titleStyle !== "8" || !relay.textOptions) continue;

    // "3번타자 홍창기" → "홍창기" (대타 포함 시 "대타 김OOO" 형태도 있음)
    const m = relay.title.match(/번타자\s+(.+)$/);
    const batterName = (m ? m[1] : relay.title).trim();
    if (!batterName) continue;

    for (const opt of relay.textOptions) {
      // type 13 = 일반 타석 결과, type 23 = 희생플라이/볼넷/아웃 등.
      // 23에는 2루타/3루타/홈런이 안 들어오지만 안전하게 같이 처리.
      if (opt.type !== 13 && opt.type !== 23) continue;
      const text = opt.text || "";
      let h2b = 0;
      let h3b = 0;
      let hr = 0;
      // 우선순위: 홈런 > 3루타 > 2루타. "1루타"는 단타라 카운트 안 함.
      if (text.includes("홈런")) hr = 1;
      else if (text.includes("3루타") || text.includes("삼루타")) h3b = 1;
      else if (text.includes("2루타") || text.includes("이루타")) h2b = 1;
      if (!h2b && !h3b && !hr) continue;
      const cur = counts.get(batterName) ?? { h2b: 0, h3b: 0, hr: 0 };
      counts.set(batterName, {
        h2b: cur.h2b + h2b,
        h3b: cur.h3b + h3b,
        hr: cur.hr + hr,
      });
    }
  }

  return counts;
}

async function fetchInning(
  naverGameId: string,
  inning: number,
): Promise<{ relays: NaverTextRelay[]; inn: number }> {
  try {
    const res = await fetch(
      `${NAVER_API}/${naverGameId}/relay?inning=${inning}`,
      { headers: HEADERS, cache: "no-store" },
    );
    if (!res.ok) return { relays: [], inn: 0 };
    const json = (await res.json()) as NaverRelayResponse;
    return {
      relays: json.result?.textRelayData?.textRelays ?? [],
      inn: json.result?.textRelayData?.inn ?? 0,
    };
  } catch {
    return { relays: [], inn: 0 };
  }
}

/**
 * Fetch all innings of a Naver relay and tally 2루타/3루타/홈런 per batter.
 * Returns an empty map on any fetch failure (caller falls back to record-only).
 */
export async function fetchNaverRelayBatterCounts(
  naverGameId: string,
): Promise<Map<string, BatterRelayCount>> {
  const first = await fetchInning(naverGameId, 1);
  const inn = first.inn || 1;
  // 연장 포함 최대 15회까지만.
  const maxInning = Math.min(Math.max(inn, 1), 15);

  const all: NaverTextRelay[][] = [first.relays];
  if (maxInning > 1) {
    const tail = await Promise.all(
      Array.from({ length: maxInning - 1 }, (_, i) =>
        fetchInning(naverGameId, i + 2).then((r) => r.relays),
      ),
    );
    all.push(...tail);
  }

  return tallyHitsFromRelays(all.flat());
}
