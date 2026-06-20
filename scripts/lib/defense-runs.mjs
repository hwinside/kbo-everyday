/**
 * 수비 runs 환산 (RF-lite / TZR-lite) — KBO 수비기록(stats-{season}-defense.json) → { [kboId]: defRuns }
 *
 * 정밀 OAA/DRS는 아니지만 "포지션만"보다 훨씬 정밀:
 *  - 야수(포수 제외): 포지션별 리그평균 대비 (PO+A) 레인지 + 실책 페널티
 *  - 포수: PO가 삼진捕球 위주라 레인지 모델 부적합 → 도루저지(CS)/허용(SB)/포일(PB)을 리그평균 대비 환산
 *  - 투수 수비(투수 포지션)는 노이즈라 제외
 *  - 표본 적은 이닝은 0쪽으로 회귀(reliability), 과대치 캡
 * 절대 스케일은 네이버 WAR 캘리브레이션(BATTER_WAR_CAL)이 흡수 → 상대 정렬/오차 축소가 목적.
 */

const PITCHER_POS = "투수";
const CATCHER_POS = "포수";

// run weights (네이버 캘리브레이션이 스케일 흡수하므로 합리적 값이면 충분)
const RANGE_W = 0.20; // (PO+A) 평균 대비 1개당 runs
const ERR_W = 0.50; // 실책 평균 대비 1개당 runs(음수)
const CS_W = 0.45; // 도루저지 평균 대비 1개당 runs
const SB_W = 0.20; // 도루허용 평균 대비 1개당 runs(음수)
const PB_W = 0.30; // 포일 평균 대비 1개당 runs(음수)
const REL_INN = 250; // 이 이닝 이상이면 reliability 1.0
const CAP = 20; // 시즌 수비 runs 절대 캡

export function parseInnings(ip) {
  if (!ip || ip === "0") return 0;
  const parts = String(ip).trim().split(" ");
  let n = parseInt(parts[0]) || 0;
  if (parts[1]) {
    const [a, b] = parts[1].split("/");
    n += (parseInt(a) || 0) / (parseInt(b) || 1);
  }
  return n;
}

export function computeDefenseRuns(rows) {
  // 1) 포지션별 리그 합계 → 이닝당 레이트
  const lg = {}; // pos -> {po,a,e,cs,sb,pb,inn}
  for (const r of rows) {
    if (r.pos === PITCHER_POS) continue;
    const inn = parseInnings(r.ip);
    if (inn <= 0) continue;
    const p = (lg[r.pos] ||= { po: 0, a: 0, e: 0, cs: 0, sb: 0, pb: 0, inn: 0 });
    p.po += r.po || 0; p.a += r.a || 0; p.e += r.e || 0;
    p.cs += r.cs || 0; p.sb += r.sb || 0; p.pb += r.pb || 0; p.inn += inn;
  }
  const rate = {};
  for (const [pos, v] of Object.entries(lg)) {
    rate[pos] = {
      poa: (v.po + v.a) / v.inn, e: v.e / v.inn,
      cs: v.cs / v.inn, sb: v.sb / v.inn, pb: v.pb / v.inn,
    };
  }

  // 2) 선수별(포지션 행 합산) runs
  const out = {};
  for (const r of rows) {
    if (r.pos === PITCHER_POS || !r.kboId) continue;
    const inn = parseInnings(r.ip);
    if (inn <= 0) continue;
    const L = rate[r.pos];
    if (!L) continue;

    let runs;
    if (r.pos === CATCHER_POS) {
      const csAbove = (r.cs || 0) - L.cs * inn;
      const sbAbove = (r.sb || 0) - L.sb * inn;
      const pbAbove = (r.pb || 0) - L.pb * inn;
      const eAbove = (r.e || 0) - L.e * inn;
      runs = csAbove * CS_W - sbAbove * SB_W - pbAbove * PB_W - eAbove * ERR_W;
    } else {
      const poaAbove = (r.po || 0) + (r.a || 0) - L.poa * inn;
      const eAbove = (r.e || 0) - L.e * inn;
      runs = poaAbove * RANGE_W - eAbove * ERR_W;
    }

    const reliability = Math.min(1, inn / REL_INN);
    runs *= reliability;
    out[r.kboId] = (out[r.kboId] || 0) + runs;
  }

  // 3) 캡 + 반올림
  for (const k of Object.keys(out)) {
    out[k] = Math.round(Math.max(-CAP, Math.min(CAP, out[k])) * 10) / 10;
  }
  return out;
}
