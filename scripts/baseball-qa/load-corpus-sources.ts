/**
 * A17 corpus(JSONL) → Supabase 적재.
 *
 * 실행: `npm run rag:load-corpus -- --file=/path/to/corpus.jsonl [--limit=N]`
 *
 * **이번 슬라이스 범위 = 신원 판정까지.** DB 쓰기(source upsert + chunk ingest)는 다음 슬라이스다.
 * 판정 계약을 먼저 리뷰 게이트에 올리는 이유는, 오염된 귀속을 한 번 적재하면
 * 서빙 단계에서는 이미 늦기 때문이다(잘못된 entity로 답변이 나간다).
 *
 * ── 왜 별도 경로인가 ──────────────────────────────────────────────────────
 * 기존 `ingest-rag-sources.ts`의 namu 분기는 맥미니 Playwright로 실크롤한다. 그런데 맥미니
 * 홈 IP는 Cloudflare 403이라(2026-08-02 실 Chrome 교차확인: 3건 중 2건 차단) 그 경로가 막혀 있다.
 * 수집은 A17 모바일망에서만 가능하고, 결과물은 폰 로컬 JSONL로만 쌓인다.
 * 이 스크립트는 그 corpus를 **재크롤 없이** 적재하는 seam이다.
 *
 * ── 계약 ─────────────────────────────────────────────────────────────────
 * (1) **신원 게이트 필수** — corpus는 이름 문자열만으로 수집돼 오염이 섞여 있다(실측 13%).
 *     `verifyCorpusPlayerIdentity`를 통과한 문서만 해당 entity에 귀속한다.
 * (2) **판정 불가는 격리** — 버리지 않고 `ambiguous`로 남긴다(수집 자산 보존).
 * (3) **기본 dry-run** — `--apply` 없이는 DB를 쓰지 않는다. 다만 dry-run은 판정만 검증하며
 *     쓰기 경로를 증명하지 못한다(2026-08-02 교훈). 전량 전에 소량 canary를 실제로 태운다.
 * (4) **부분 반영 금지** — 기대 건수와 실제 반영 건수가 다르면 실패로 종결한다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { verifyCorpusPlayerIdentity } from "../../src/lib/baseball-qa/rag/corpus-identity";

type CorpusRecord = {
  doc: string;
  kind: string;
  entity: string;
  depth: number;
  title: string;
  canonical: string;
  len: number;
  text: string;
  fetchedAt: string;
};

type RosterPlayer = { kboId: string; name: string; birthDate?: string };

const args = process.argv.slice(2);
const argValue = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.split("=").slice(1).join("=");
const FILE = argValue("file");
const LIMIT = Number(argValue("limit") ?? "0");

/**
 * corpus 읽기 (삼순 NO-GO ②).
 *
 * 손상된 행을 **조용히 무시하면 안 된다.** 크롤 중간에 끊긴 행이 생기면 그 문서는
 * 수집됐는데도 적재에서 사라지고, 아무도 모르는 채 커버리지가 줄어든다.
 *
 * 마지막 행은 크롤이 돌는 중이면 잘려 있을 수 있는 정상 상황이므로 구분해서 보고하고,
 * **중간 행 손상은 실패로 종결**한다(조용한 누락이 가장 나쁜 실패다).
 */
function readCorpus(file: string): { records: CorpusRecord[]; brokenMiddle: number; brokenTail: number } {
  const records: CorpusRecord[] = [];
  const lines = readFileSync(file, "utf8").split("\n");
  let brokenMiddle = 0;
  let brokenTail = 0;
  const lastIndex = lines.length - 1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as CorpusRecord);
    } catch {
      if (index === lastIndex) brokenTail += 1;
      else brokenMiddle += 1;
    }
  }
  return { records, brokenMiddle, brokenTail };
}

async function main(): Promise<void> {
  if (!FILE) throw new Error("--file=<corpus.jsonl> 이 필요하다");

  const roster = JSON.parse(
    readFileSync(path.join(process.cwd(), "src/lib/constants/players-roster.json"), "utf8"),
  ) as RosterPlayer[];
  const byName = new Map<string, RosterPlayer[]>();
  for (const player of roster) {
    const list = byName.get(player.name) ?? [];
    list.push(player);
    byName.set(player.name, list);
  }

  const { records, brokenMiddle, brokenTail } = readCorpus(FILE);
  if (brokenTail > 0) {
    console.log(`주의: 마지막 행이 잘려 있다(${brokenTail}행). 크롤이 돌는 중이면 정상이다.`);
  }
  if (brokenMiddle > 0) {
    // 조용한 누락을 만들지 않는다 — 수집된 문서가 적재에서 사라지는 것이다.
    throw new Error(
      `corpus 중간에 손상된 행이 ${brokenMiddle}건 있다. 적재를 중단한다 — ` +
      `이를 무시하면 수집된 문서가 아무도 모르게 빠진다(corpus 재생성 필요).`,
    );
  }
  const roots = records.filter((record) => record.kind === "player" && record.depth === 1);
  const targets = LIMIT > 0 ? roots.slice(0, LIMIT) : roots;
  console.log(`corpus ${records.length}행 / 선수 루트문서 ${roots.length}건 / 대상 ${targets.length}건`);

  const verdicts = { resolved: 0, ambiguous: 0, rejected: 0, unknown_player: 0 };
  const reasons = new Map<string, number>();
  const accepted: { kboId: string; name: string; record: CorpusRecord }[] = [];

  for (const record of targets) {
    const candidates = byName.get(record.entity) ?? [];
    if (candidates.length === 0) {
      verdicts.unknown_player += 1;
      continue;
    }
    if (candidates.length > 1) {
      // 로스터 동명이인은 이름만으로 kboId를 특정할 수 없다. 추측하지 않는다.
      verdicts.ambiguous += 1;
      reasons.set("roster_name_ambiguous", (reasons.get("roster_name_ambiguous") ?? 0) + 1);
      continue;
    }
    const player = candidates[0];
    const verdict = verifyCorpusPlayerIdentity({
      text: record.text,
      rosterBirthYear: player.birthDate?.slice(0, 4),
      seedName: record.entity,
      documentTitle: record.title,
    });
    if (verdict.ok) {
      verdicts.resolved += 1;
      accepted.push({ kboId: player.kboId, name: player.name, record });
      continue;
    }
    if (verdict.status === "ambiguous") verdicts.ambiguous += 1;
    else verdicts.rejected += 1;
    reasons.set(verdict.reason, (reasons.get(verdict.reason) ?? 0) + 1);
  }

  console.log(`판정 요약: ${JSON.stringify(verdicts)}`);
  console.log(`사유 분포: ${JSON.stringify(Object.fromEntries([...reasons].sort((a, b) => b[1] - a[1])))}`);

  for (const entry of accepted.slice(0, 5)) {
    console.log(`  귀속 확정 ${entry.name}(${entry.kboId}) ← ${entry.record.canonical}`);
  }
  console.log("\n이 슬라이스는 DB를 쓰지 않는다(판정 전용). 적재는 다음 슬라이스에서 붙이며,");
  console.log("그때도 전량 전에 소량 canary를 실제 쓰기로 태워 사전/사후 스냅샷을 대조한다(dry-run은 쓰기 경로를 증명하지 못한다).");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
