/**
 * KBO 수비기록(포지션별 행, stats-{season}-defense.json) → 선수별 집계.
 * 기록실 "수비" 노출용. 한 선수가 여러 포지션을 보면 합산하고 주 포지션(최다 이닝)을 라벨로.
 */

export interface DefenseRow {
  name: string; team: string; kboId: string; pos: string;
  games: number; ip: string; e: number; pko: number; po: number;
  a: number; dp: number; fpct: string; pb: number; sb: number; cs: number;
}

export interface AggregatedDefense {
  name: string; team: string; kboId: string;
  position: string; // 주 포지션(최다 이닝)
  innings: number; // 수비 이닝(소수)
  games: number; // 주 포지션 경기수
  po: number; a: number; e: number; dp: number; pb: number;
  poa: number; // 자살+보살
  fpct: number; // 종합 수비율 (po+a)/(po+a+e)
}

export function parseInnings(ip: string): number {
  if (!ip || ip === "0") return 0;
  const parts = String(ip).trim().split(" ");
  let n = parseInt(parts[0]) || 0;
  if (parts[1]) {
    const [a, b] = parts[1].split("/");
    n += (parseInt(a) || 0) / (parseInt(b) || 1);
  }
  return Math.round(n * 10) / 10;
}

export function aggregateDefense(rows: DefenseRow[]): AggregatedDefense[] {
  const byPlayer = new Map<string, AggregatedDefense & { _primInn: number }>();
  for (const r of rows) {
    if (!r.kboId || r.pos === "투수") continue; // 투수 수비 제외
    const inn = parseInnings(r.ip);
    const cur = byPlayer.get(r.kboId);
    if (!cur) {
      byPlayer.set(r.kboId, {
        name: r.name, team: r.team, kboId: r.kboId,
        position: r.pos, innings: inn, games: r.games || 0,
        po: r.po || 0, a: r.a || 0, e: r.e || 0, dp: r.dp || 0, pb: r.pb || 0,
        poa: (r.po || 0) + (r.a || 0), fpct: 0, _primInn: inn,
      });
    } else {
      cur.innings = Math.round((cur.innings + inn) * 10) / 10;
      cur.po += r.po || 0; cur.a += r.a || 0; cur.e += r.e || 0;
      cur.dp += r.dp || 0; cur.pb += r.pb || 0;
      cur.poa = cur.po + cur.a;
      if (inn > cur._primInn) { cur.position = r.pos; cur.games = r.games || 0; cur._primInn = inn; }
    }
  }
  const out: AggregatedDefense[] = [];
  for (const v of byPlayer.values()) {
    const denom = v.po + v.a + v.e;
    v.fpct = denom > 0 ? Math.round((v.po + v.a) / denom * 1000) / 1000 : 0;
    const { _primInn, ...rest } = v;
    void _primInn;
    out.push(rest);
  }
  return out;
}
