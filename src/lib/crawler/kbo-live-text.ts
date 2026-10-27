import type { NaverTextRelay, RelayLinescore } from '@/app/api/game-relay/route';
import type { GameDetailResponse, BatterRecord, PitcherRecord } from '@/lib/services/game-detail';
import { isCanonicalKboGameId } from '@/lib/game/game-id';
import { resolveGameSeries } from './resolve-game-series';

export interface KboLiveText {
  gameId: string;
  updatedAt: string;
  rows: NaverTextRelay[];
  linescore: RelayLinescore;
  boxScore: NonNullable<GameDetailResponse['boxScore']>;
}
const clean = (s: string) => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/\s+/g, ' ').trim();
const cells = (s: string) => [...s.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(m => clean(m[1]));
const rows = (s: string) => [...(s.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(m => cells(m[1]));
const number = (s: string) => { if (!/^\d+$/.test(s)) throw new Error('KBO live numeric schema'); return Number(s); };
const table = (s: string, id: string) => s.match(new RegExp(`<table\\b[^>]*id="${id}"[^>]*>([\\s\\S]*?)<\\/table>`, 'i'))?.[1] ?? '';

/** KBO lists each inning newest-first. Preserve source rows, never synthesize plays from score differences. */
export function parseKboLiveText(gameId: string, scoreHtml: string, textHtml: string): KboLiveText {
  if (!isCanonicalKboGameId(gameId)) throw new Error('invalid game id');
  const date = `${gameId.slice(0, 4)}-${gameId.slice(4, 6)}-${gameId.slice(6, 8)}`;
  const ground = textHtml.match(/<p\b[^>]*class="ground"[^>]*>([\s\S]*?)<\/p>/)?.[1] ?? '';
  if (!clean(ground).startsWith(date)) throw new Error('KBO live date mismatch');
  const chronological: NaverTextRelay[] = [];
  const groups = new Map<number, string[]>();
  for (const m of textHtml.matchAll(/<span\b[^>]*id="rptLiveText(\d+)_spanLiveText_\d+"[^>]*>([\s\S]*?)<\/span>/g)) {
    const n = Number(m[1]);
    const list = groups.get(n) ?? [];
    list.push(clean(m[2]).replace(/^\s*-\s*/, '').replace(/\s*-{3,}$/, '').trim());
    groups.set(n, list);
  }
  let batter: string | undefined;
  for (const [, texts] of [...groups].sort((a, b) => a[0] - b[0])) {
    for (const text of [...texts].reverse()) {
      if (/^\d+회(초|말)\s+.+?\s+공격$/.test(text)) {
        chronological.push({ title: text, titleStyle: '0' }); batter = undefined; continue;
      }
      // Replacement notices are not batter names. Only an offensive pinch-hit
      // replacement of the active batter opens a replacement batter marker;
      // defensive changes must leave the active at-bat untouched.
      const replacement = /^(\d+번타자|대타)\s+([^:]+?)\s*:\s*대타\s+(.+?)\s+\(으\)로 교체$/.exec(text);
      if (replacement && replacement[2].trim() === batter) {
        chronological.push({ title: text, titleStyle: '8', textOptions: [{ seqno: chronological.length, text, type: 2 }] });
        batter = replacement[3].trim();
        const marker = `${replacement[1]} ${batter}`;
        chronological.push({ title: marker, titleStyle: '8', textOptions: [{ seqno: chronological.length, text: marker, type: 8 }] });
        continue;
      }
      const start = /^(?:\d+번타자|대타)\s+([^:]+)$/.exec(text);
      const pitch = /^(\d+)구\s+/.exec(text);
      let type = 2;
      if (start) { batter = start[1]; type = 8; }
      else if (pitch) type = 1;
      else if (batter && text.startsWith(`${batter} : `)) { type = 13; batter = undefined; }
      else if (/^[123]루주자\s/.test(text)) type = 14;
      chronological.push({ title: text, titleStyle: '8', textOptions: [{ seqno: chronological.length, text, type, ...(pitch ? { pitchNum: Number(pitch[1]) } : {}) }] });
    }
  }
  if (!chronological.some(r => r.titleStyle === '0')) throw new Error('KBO live text unavailable');
  const innings = rows(table(scoreHtml, 'tblScoreBoard2'));
  const totals = rows(table(scoreHtml, 'tblScoreBoard3'));
  if (innings.length !== 2 || totals.length !== 2 || innings.some(r => r.length < 9) || totals.some(r => r.length !== 4)) throw new Error('KBO linescore schema');
  const side = (i: number) => ({ innings: innings[i].map(v => v === '-' || v === '' || v === 'X' ? null : number(v)), R: number(totals[i][0]), H: number(totals[i][1]), E: number(totals[i][2]) });
  const allTables = [...textHtml.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(m => m[1]);
  const batterTables = allTables.filter(t => /<th[^>]*>\s*병살\s*<\/th>/.test(t));
  const pitcherTables = allTables.filter(t => /<th[^>]*>\s*투구\s*<\/th>/.test(t));
  const lineupTables = allTables.filter(t => /<caption>[^<]* 타자<\/caption>/.test(t));
  if (batterTables.length !== 2 || pitcherTables.length !== 2 || lineupTables.length !== 2) throw new Error('KBO boxscore schema');
  const positions: Record<string, string> = { '1': '투수', '2': '포수', '3': '1루수', '4': '2루수', '5': '3루수', '6': '유격수', '7': '좌익수', '8': '중견수', '9': '우익수', D: '지명타자', H: '대타', R: '대주자' };
  const batters = (i: number): BatterRecord[] => {
    const lineup = rows(lineupTables[i]);
    return rows(batterTables[i]).map(c => {
      if (c.length !== 12 || !c[0]) throw new Error('KBO batter schema');
      const slot = lineup.find(l => l[2] === c[0]);
      const pos = positions[slot?.[1] ?? ''] ?? '';
      return { name: c[0], order: Number(slot?.[0]) || 0, position: pos, positionFull: pos, atBats: number(c[1]), runs: number(c[2]), hits: number(c[3]), hr: number(c[4]), rbi: number(c[5]), sb: number(c[6]), bb: number(c[8]), so: number(c[9]), h2b: chronological.filter(r => r.textOptions?.some(o => o.type === 13 && o.text.startsWith(`${c[0]} : `) && o.text.includes('2루타') && !o.text.includes('아웃'))).length, h3b: chronological.filter(r => r.textOptions?.some(o => o.type === 13 && o.text.startsWith(`${c[0]} : `) && o.text.includes('3루타') && !o.text.includes('아웃'))).length, avg: '', isSubstitute: !slot?.[0] };
    });
  };
  const pitchers = (i: number): PitcherRecord[] => rows(pitcherTables[i]).map(c => {
    if (c.length !== 12 || !c[0]) throw new Error('KBO pitcher schema');
    return { name: c[0], inningsPitched: c[1], decision: '', battersFaced: number(c[2]), pitchCount: number(c[3]), atBats: number(c[4]), hits: number(c[5]), hr: number(c[6]), walks: number(c[8]), strikeouts: number(c[9]), runs: number(c[10]), earnedRuns: number(c[11]), era: '' };
  });
  return { gameId, updatedAt: new Date().toISOString(), rows: chronological.reverse(), linescore: { away: side(0), home: side(1) }, boxScore: { awayBatters: batters(0), homeBatters: batters(1), awayPitchers: pitchers(0), homePitchers: pitchers(1) } };
}

export class KboCollectionBusyError extends Error {}

export type RedisCommand = (args: (string | number)[], signal: AbortSignal) => Promise<unknown>;
async function redis(args: (string | number)[], signal: AbortSignal): Promise<unknown> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('KBO shared cache unavailable');
  const res = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(args), cache: 'no-store', signal });
  if (!res.ok) throw new Error('KBO cache HTTP error');
  const payload = await res.json();
  if (payload.error) throw new Error('KBO cache command failed');
  return payload.result;
}

/** Shared admission remains closed for 10s even on upstream failure. No local fallback on Redis failure. */
export async function loadKboLiveText(gameId: string, opts: { signal?: AbortSignal; srId?: string; command?: RedisCommand; fetcher?: typeof fetch } = {}): Promise<KboLiveText> {
  if (!isCanonicalKboGameId(gameId)) throw new Error('invalid game id');
  // Respect the caller's absolute deadline; only standalone relay calls own a timer.
  const signal = opts.signal ?? AbortSignal.timeout(2800);
  const command = opts.command ?? redis;
  const environment = process.env.VERCEL_ENV ?? 'development';
  if (!['production', 'preview', 'development'].includes(environment)) throw new Error('Invalid KBO cache environment');
  // Snapshot and admission share this namespace; Preview never reads/writes production keys.
  const key = `kbo:live-text:v1:${environment}:${gameId}`;
  const cached = await command(['GET', key], signal);
  if (typeof cached === 'string') {
    const data = JSON.parse(cached) as KboLiveText;
    const age = Date.now() - Date.parse(data.updatedAt);
    if (data.gameId === gameId && age >= 0 && age < 10_000) return data;
  }
  const token = crypto.randomUUID();
  if (await command(['SET', `${key}:admission`, token, 'NX', 'PX', 10_000], signal) !== 'OK') throw new KboCollectionBusyError('KBO collection busy');
  const srId = await resolveGameSeries(gameId, { srId: opts.srId, signal });
  const fetcher = opts.fetcher ?? fetch;
  const body = new URLSearchParams({ leagueId: '1', seriesId: srId, gameId, gyear: gameId.slice(0, 4) }).toString();
  const views = await Promise.all([1, 2].map(async n => {
    const res = await fetcher(`https://www.koreabaseball.com/Game/LiveTextView${n}.aspx`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, cache: 'no-store', signal });
    if (!res.ok) throw new Error(`KBO live HTTP ${res.status}`);
    const html = await res.text();
    signal.throwIfAborted();
    if (html.length > 2_000_000) throw new Error('KBO live oversized');
    return html;
  }));
  const data = parseKboLiveText(gameId, views[0], views[1]);
  signal.throwIfAborted();
  // The admission token fences late writers after lease expiry.
  const saved = await command(['EVAL', "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('SET',KEYS[2],ARGV[2],'PX',10000) else return nil end", 2, `${key}:admission`, key, token, JSON.stringify(data)], signal);
  if (saved !== 'OK') throw new Error('KBO snapshot publish failed');
  return data;
}
