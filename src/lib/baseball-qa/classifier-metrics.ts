/** Frozen contract: case-paired resampling, 10,000 draws, seed 20260920. */
export interface PairedLabels { gold: string; baseline: string; candidate: string }
function scores(rows: readonly PairedLabels[], labels: readonly string[], side: "baseline" | "candidate") {
  const accuracy = rows.filter(r => r[side] === r.gold).length / rows.length;
  const macroF1 = labels.reduce((sum, label) => {
    const tp = rows.filter(r => r.gold === label && r[side] === label).length;
    const fp = rows.filter(r => r.gold !== label && r[side] === label).length;
    const fn = rows.filter(r => r.gold === label && r[side] !== label).length;
    return sum + (2 * tp + fp + fn === 0 ? 0 : 2 * tp / (2 * tp + fp + fn));
  }, 0) / labels.length;
  return { accuracy, macroF1 };
}

/** Invalid/provider/no-majority predictions stay in the denominator as wrong labels. */
export function pairedClassifierMetrics(rows: readonly PairedLabels[], labels: readonly string[]) {
  if (!rows.length || !labels.length || new Set(labels).size !== labels.length || rows.some(r => !labels.includes(r.gold))) {
    throw new Error("Nonempty paired cases and a fixed unique gold label set are required");
  }
  const baseline = scores(rows, labels, "baseline");
  const candidate = scores(rows, labels, "candidate");
  let state = 20260920;
  const random = () => {
    state |= 0; state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
  const accuracy: number[] = [], macroF1: number[] = [];
  for (let i = 0; i < 10000; i++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(random() * rows.length)]);
    const b = scores(sample, labels, "baseline"), c = scores(sample, labels, "candidate");
    accuracy.push(c.accuracy - b.accuracy); macroF1.push(c.macroF1 - b.macroF1);
  }
  const interval = (values: number[]) => {
    values.sort((a, b) => a - b);
    const quantile = (p: number) => {
      const index = (values.length - 1) * p, lo = Math.floor(index), hi = Math.ceil(index);
      return values[lo] + (values[hi] - values[lo]) * (index - lo);
    };
    return [quantile(0.025), quantile(0.975)] as const;
  };
  return { n: rows.length, labels: [...labels], baseline, candidate,
    delta: { accuracy: candidate.accuracy - baseline.accuracy, macroF1: candidate.macroF1 - baseline.macroF1 },
    ci95: { accuracy: interval(accuracy), macroF1: interval(macroF1) },
    bootstrap: { repetitions: 10000, seed: 20260920, unit: "case", method: "percentile-linear" },
  };
}
