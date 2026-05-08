#!/usr/bin/env node
// Smoke validator for naver relay textRelay parser.
// Usage: node scripts/validate-naver-relay-counts.mjs <kboGameId>
// e.g.   node scripts/validate-naver-relay-counts.mjs 20260508LGHH0
//
// Fetches all innings of Naver relay for the given game and prints the
// per-batter 2루타/3루타/홈런 tally. Use to confirm fix(naver-relay) results
// without spinning up the full Next dev server.

const NAVER_API = "https://api-gw.sports.naver.com/schedule/games";
const HEADERS = { "User-Agent": "Mozilla/5.0 (compatible; KboEveryday/1.0)" };

const kboGameId = process.argv[2];
if (!kboGameId || !/^\d{8}[A-Z]{4}\d$/.test(kboGameId)) {
  console.error("usage: node scripts/validate-naver-relay-counts.mjs <kboGameId>");
  console.error("       e.g. 20260508LGHH0");
  process.exit(1);
}

const naverGameId = `${kboGameId}${kboGameId.slice(0, 4)}`;

async function fetchInning(inning) {
  try {
    const r = await fetch(`${NAVER_API}/${naverGameId}/relay?inning=${inning}`, {
      headers: HEADERS,
    });
    if (!r.ok) return { relays: [], inn: 0 };
    const j = await r.json();
    return {
      relays: j?.result?.textRelayData?.textRelays ?? [],
      inn: j?.result?.textRelayData?.inn ?? 0,
    };
  } catch {
    return { relays: [], inn: 0 };
  }
}

function tally(textRelays) {
  const counts = new Map();
  for (const relay of textRelays) {
    if (relay.titleStyle !== "8" || !relay.textOptions) continue;
    const m = relay.title?.match(/번타자\s+(.+)$/);
    const batterName = (m ? m[1] : relay.title || "").trim();
    if (!batterName) continue;
    for (const opt of relay.textOptions) {
      if (opt.type !== 13 && opt.type !== 23) continue;
      const text = opt.text || "";
      let h2b = 0, h3b = 0, hr = 0;
      if (text.includes("홈런")) hr = 1;
      else if (text.includes("3루타") || text.includes("삼루타")) h3b = 1;
      else if (text.includes("2루타") || text.includes("이루타")) h2b = 1;
      if (!h2b && !h3b && !hr) continue;
      const cur = counts.get(batterName) ?? { h2b: 0, h3b: 0, hr: 0, samples: [] };
      counts.set(batterName, {
        h2b: cur.h2b + h2b,
        h3b: cur.h3b + h3b,
        hr: cur.hr + hr,
        samples: [...cur.samples, text],
      });
    }
  }
  return counts;
}

const first = await fetchInning(1);
const inn = Math.min(Math.max(first.inn || 1, 1), 15);
const all = [first.relays];
if (inn > 1) {
  const tail = await Promise.all(
    Array.from({ length: inn - 1 }, (_, i) => fetchInning(i + 2).then((r) => r.relays)),
  );
  all.push(...tail);
}
const flat = all.flat();
const counts = tally(flat);

console.log(`naverGameId=${naverGameId}  innings=${inn}  textRelaysTotal=${flat.length}`);
console.log("---");
const entries = [...counts.entries()].sort((a, b) =>
  b[1].h2b + b[1].h3b * 2 + b[1].hr * 3 - (a[1].h2b + a[1].h3b * 2 + a[1].hr * 3),
);
for (const [name, v] of entries) {
  const parts = [];
  if (v.hr) parts.push(`HR=${v.hr}`);
  if (v.h3b) parts.push(`3B=${v.h3b}`);
  if (v.h2b) parts.push(`2B=${v.h2b}`);
  console.log(`${name.padEnd(8)} ${parts.join(" ")}`);
  for (const s of v.samples) console.log(`  · ${s}`);
}
if (entries.length === 0) console.log("(no extra-base hits parsed)");
