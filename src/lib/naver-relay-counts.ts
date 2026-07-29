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

  // Batter는 *opt.text* parts[0]에서 직접 추출 (SSOT). 과거엔 relay.title의
  // `/번타자\s+(.+)/`만 매칭하고 비표준 title(대타/대주자/대수비)은 title 전체를
  // batter key로 잘못 저장 → game-detail의 record API batter name lookup이
  // miss → 라이브 중 h2b/h3b/hr가 단타로 뭉개졌다 (2026-05-27 문정빈 3루타 P0).
  // 또 `titleStyle !== "8"` skip이 같은 변종 row(대타는 보통 style="2")를 전부
  // 차단. opt.type=13/23 자체가 "타석 결과" 마커라서 opt.text "X : 결과" 포맷이
  // SSOT — title을 거치지 않아도 batter 안전 식별 가능. " : " 분리자 없으면
  // 정상 result line 아니므로 skip. parseInningRelays(game-relay/route.ts)와
  // 동일 패턴.
  for (const relay of textRelays) {
    if (!relay.textOptions) continue;

    for (const opt of relay.textOptions) {
      // type 13 = 일반 타석 결과, type 23 = 희생플라이/볼넷/아웃 등.
      // 23에는 2루타/3루타/홈런이 안 들어오지만 안전하게 같이 처리.
      if (opt.type !== 13 && opt.type !== 23) continue;
      const text = opt.text || "";
      const parts = text.split(" : ");
      if (parts.length < 2) continue;
      const batterName = parts[0].trim();
      if (!batterName) continue;
      const resultText = parts.slice(1).join(" : ");
      let h2b = 0;
      let h3b = 0;
      let hr = 0;
      // 우선순위: 홈런 > 3루타 > 2루타. "1루타"는 단타라 카운트 안 함.
      if (resultText.includes("홈런")) hr = 1;
      else if (resultText.includes("3루타") || resultText.includes("삼루타")) h3b = 1;
      else if (resultText.includes("2루타") || resultText.includes("이루타")) h2b = 1;
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
  signal?: AbortSignal,
): Promise<{ relays: NaverTextRelay[]; inn: number }> {
  try {
    const res = await fetch(
      `${NAVER_API}/${naverGameId}/relay?inning=${inning}`,
      { headers: HEADERS, cache: "no-store", signal },
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
  opts?: { signal?: AbortSignal },
): Promise<Map<string, BatterRelayCount>> {
  const first = await fetchInning(naverGameId, 1, opts?.signal);
  const inn = first.inn || 1;
  // 연장 포함 최대 15회까지만.
  const maxInning = Math.min(Math.max(inn, 1), 15);

  const all: NaverTextRelay[][] = [first.relays];
  if (maxInning > 1) {
    const tail = await Promise.all(
      Array.from({ length: maxInning - 1 }, (_, i) =>
        fetchInning(naverGameId, i + 2, opts?.signal).then((r) => r.relays),
      ),
    );
    all.push(...tail);
  }

  return tallyHitsFromRelays(all.flat());
}
