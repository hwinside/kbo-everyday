/**
 * 실 corpus 선수 루트문서 **전건 신원 재판정** — 재현 가능한 감사 산출물.
 *
 * ⚠️ 왜 필요한가 (삼순 NO-GO ⑤): 이전 판은 "238→242 로 늘었다"고만 보고했고 입력 hash·대상
 *   kboId·판정 before/after 가 PR 어디에도 없었다. 그러면 그 숫자는 재현할 수 없는 주장이다.
 *
 * 이 스크립트는 corpus 전건을 현재 게이트로 재판정하고
 * `scripts/qa/fixtures/corpus-identity-census.json` 을 만든다. 산출물에는
 * 입력 파일 SHA-256·레코드 수·판정 분포·전건 kboId 별 판정이 들어간다.
 *
 * 실행(로컬, T7 corpus 필요):
 *   CORPUS=/Volumes/T7-Dev/reviews/runtime/namu-corpus-complete.jsonl \
 *   npx tsx scripts/qa/corpus-identity-census.ts
 *
 * ⚠️ corpus(175MB)는 repo 에 없으므로 이 스크립트는 CI 게이트가 아니다. 산출물만 커밋되고,
 *   회귀 게이트는 이 산출물에서 뽑은 fixture 로 `qa:baseball-corpus-identity` 가 담당한다.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import readline from "node:readline";

import { verifyCorpusPlayerIdentity } from "../../src/lib/baseball-qa/rag/corpus-identity";

type Roster = { name: string; kboId: string; birthDate?: string };

async function main(): Promise<void> {
  const corpusPath = process.env.CORPUS;
  if (!corpusPath) throw new Error("CORPUS 환경변수에 corpus jsonl 경로를 지정해야 한다");

  const roster: Roster[] = JSON.parse(fs.readFileSync("src/lib/constants/players-roster.json", "utf8"));
  const byName = new Map<string, Roster[]>();
  for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);

  // 입력 지문 — 이 산출물이 어떤 corpus 에서 나왔는지 고정한다.
  const inputHash = createHash("sha256");
  const latest = new Map<string, { entity: string; title: string; canonical: string; fetchedAt: string; text: string }>();
  let physicalLines = 0;
  const stream = readline.createInterface({ input: fs.createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of stream) {
    if (line.length === 0) continue;
    inputHash.update(line);
    inputHash.update("\n");
    physicalLines += 1;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.kind !== "player" || record.depth !== 1) continue;
    if (!byName.has(record.entity)) continue;
    const key = `${record.entity}\u0000${record.canonical}`;
    const previous = latest.get(key);
    if (!previous || previous.fetchedAt < record.fetchedAt) {
      latest.set(key, {
        entity: record.entity, title: record.title, canonical: record.canonical,
        fetchedAt: record.fetchedAt, text: record.text,
      });
    }
  }

  const verdicts: Record<string, number> = {};
  const rows = [...latest.values()]
    .sort((a, b) => a.entity.localeCompare(b.entity, "ko"))
    .map((root) => {
      const candidates = byName.get(root.entity) ?? [];
      const player = candidates.length === 1 ? candidates[0] : undefined;
      const verdict = verifyCorpusPlayerIdentity({
        text: root.text,
        rosterBirthYear: player?.birthDate?.slice(0, 4),
        rosterBirthDate: player?.birthDate,
        seedName: root.entity,
        documentTitle: root.title,
      });
      const label = candidates.length !== 1
        ? "roster_name_ambiguous"
        : verdict.ok
          ? (verdict.birthEvidence === "roster_date_stated_in_document" ? "assigned_birth_rescued" : "assigned")
          : `${verdict.status}:${verdict.reason}`;
      verdicts[label] = (verdicts[label] ?? 0) + 1;
      return {
        entity: root.entity,
        kboId: player?.kboId ?? null,
        rosterBirthDate: player?.birthDate ?? null,
        canonical: root.canonical,
        fetchedAt: root.fetchedAt,
        verdict: label,
      };
    });

  const assigned = rows.filter((row) => row.verdict.startsWith("assigned")).length;
  fs.writeFileSync(
    "scripts/qa/fixtures/corpus-identity-census.json",
    `${JSON.stringify({
      note: "실 corpus 선수 루트문서 전건 신원 재판정. build: scripts/qa/corpus-identity-census.ts",
      corpusFile: corpusPath.split("/").pop(),
      corpusSha256: inputHash.digest("hex"),
      corpusPhysicalLines: physicalLines,
      rosterPlayers: roster.length,
      playerRootDocuments: rows.length,
      assigned,
      verdicts,
      rows,
    }, null, 1)}\n`,
  );
  console.log(`census: ${rows.length} roots · assigned ${assigned}`);
  console.log(JSON.stringify(verdicts, null, 1));
}

void main();
