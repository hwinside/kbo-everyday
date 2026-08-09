/**
 * 실 corpus 선수 루트문서 **전건 신원 재판정** — 재현 가능한 감사 산출물.
 *
 * ⚠️ 왜 필요한가 (삼순 NO-GO ⑤ → 2차 ②): 처음엔 "238→242" 처럼 숫자만 보고했고, 다음 판은
 *   현재 verdict 만 담아서 `156→395` 의 **before/after 와 전이 대상**을 재현할 수 없었다.
 *   숫자를 재현할 수 없으면 그건 주장일 뿐이다.
 *
 * 그래서 이 산출물은 세 가지를 한 파일에 고정한다:
 *   1. **입력 지문** — corpus 파일 SHA-256, 물리 행 수, 로스터 파일 SHA-256.
 *      fixture 파일(`corpus-identity-documents.json`)도 같은 corpus SHA 를 갖고 있어야
 *      두 artifact 가 같은 입력에서 나왔음이 증명된다(smoke 가 이 일치를 검사한다).
 *   2. **행별 base / current / transition** — base 는 이 PR 이전 게이트(`baseRef` 시점 소스)의
 *      판정이다. 스크립트가 그 시점 구현을 **실제로 로드해서** 돌린다(재서술이 아니다).
 *   3. **원문 지문** — 행마다 문서 본문 SHA-256. 나중에 corpus 가 바뀌면 어느 행이 바뀌었는지
 *      대조할 수 있다.
 *
 * 실행(로컬, T7 corpus 필요):
 *   CORPUS=/Volumes/T7-Dev/reviews/runtime/namu-corpus-complete.jsonl \
 *   BASE_IDENTITY=/tmp/ca/base-identity.ts \
 *   npx tsx scripts/qa/corpus-identity-census.ts
 *
 *   BASE_IDENTITY 는 비교 기준이 되는 **이전 버전 corpus-identity.ts** 파일 경로다.
 *   예: `git show <baseSha>:src/lib/baseball-qa/rag/corpus-identity.ts > /tmp/base-identity.ts`
 *
 * ⚠️ corpus(175MB)는 repo 에 없으므로 이 스크립트는 CI 게이트가 아니다. 산출물만 커밋되고,
 *   회귀 게이트는 이 산출물에서 뽑은 fixture 로 `qa:baseball-corpus-identity` 가 담당한다.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { verifyCorpusPlayerIdentity, type CorpusIdentityVerdict } from "../../src/lib/baseball-qa/rag/corpus-identity";

type Roster = { name: string; kboId: string; birthDate?: string };
type IdentityInput = Parameters<typeof verifyCorpusPlayerIdentity>[0];
type IdentityFn = (input: IdentityInput) => CorpusIdentityVerdict;

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");

/** 판정 → 감사 라벨. assigned 는 구제 여부까지 구분한다. */
function labelOf(verdict: CorpusIdentityVerdict, rosterCandidates: number): string {
  if (rosterCandidates !== 1) return "roster_name_ambiguous";
  if (!verdict.ok) return `${verdict.status}:${verdict.reason}`;
  return verdict.birthEvidence === "roster_date_stated_in_document" ? "assigned_birth_rescued" : "assigned";
}

/** 이전 버전 구현은 `birthEvidence` 가 없다 — 그 시점 계약대로 assigned 로만 읽는다. */
function baseLabelOf(verdict: CorpusIdentityVerdict, rosterCandidates: number): string {
  if (rosterCandidates !== 1) return "roster_name_ambiguous";
  if (!verdict.ok) return `${verdict.status}:${verdict.reason}`;
  return "assigned";
}

async function loadBaseIdentity(baseIdentityPath: string): Promise<{ fn: IdentityFn; sha: string }> {
  const source = fs.readFileSync(baseIdentityPath);
  // tsx 로 실행되므로 .ts 를 그대로 import 할 수 있다. 이전 구현을 **실제로 실행**해서
  // base 판정을 만든다 — 손으로 옮겨 적으면 그게 또 재현 불가능한 주장이 된다.
  const loaded = (await import(path.resolve(baseIdentityPath))) as { verifyCorpusPlayerIdentity: IdentityFn };
  if (typeof loaded.verifyCorpusPlayerIdentity !== "function") {
    throw new Error(`base identity 모듈에 verifyCorpusPlayerIdentity 가 없다: ${baseIdentityPath}`);
  }
  return { fn: loaded.verifyCorpusPlayerIdentity, sha: sha256(source) };
}

async function main(): Promise<void> {
  const corpusPath = process.env.CORPUS;
  if (!corpusPath) throw new Error("CORPUS 환경변수에 corpus jsonl 경로를 지정해야 한다");
  const baseIdentityPath = process.env.BASE_IDENTITY;
  if (!baseIdentityPath) throw new Error("BASE_IDENTITY 환경변수에 비교 기준 corpus-identity.ts 경로를 지정해야 한다");

  const rosterRaw = fs.readFileSync("src/lib/constants/players-roster.json");
  const roster: Roster[] = JSON.parse(rosterRaw.toString("utf8"));
  const byName = new Map<string, Roster[]>();
  for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);

  const base = await loadBaseIdentity(baseIdentityPath);
  const currentSha = sha256(fs.readFileSync("src/lib/baseball-qa/rag/corpus-identity.ts"));

  const corpusHash = createHash("sha256");
  const latest = new Map<string, { entity: string; title: string; canonical: string; fetchedAt: string; text: string }>();
  let physicalLines = 0;
  const stream = readline.createInterface({ input: fs.createReadStream(corpusPath), crlfDelay: Infinity });
  for await (const line of stream) {
    if (line.length === 0) continue;
    corpusHash.update(line);
    corpusHash.update("\n");
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

  const baseVerdicts: Record<string, number> = {};
  const currentVerdicts: Record<string, number> = {};
  const transitions: Record<string, number> = {};
  const rows = [...latest.values()]
    .sort((a, b) => a.entity.localeCompare(b.entity, "ko"))
    .map((root) => {
      const candidates = byName.get(root.entity) ?? [];
      const player = candidates.length === 1 ? candidates[0] : undefined;
      const input: IdentityInput = {
        text: root.text,
        rosterBirthYear: player?.birthDate?.slice(0, 4),
        rosterBirthDate: player?.birthDate,
        seedName: root.entity,
        documentTitle: root.title,
      };
      const baseLabel = baseLabelOf(base.fn(input), candidates.length);
      const currentLabel = labelOf(verifyCorpusPlayerIdentity(input), candidates.length);
      const baseAssigned = baseLabel.startsWith("assigned");
      const currentAssigned = currentLabel.startsWith("assigned");
      const transition = baseAssigned === currentAssigned
        ? (baseAssigned ? "kept_assigned" : "kept_excluded")
        : (currentAssigned ? "gained" : "lost");
      baseVerdicts[baseLabel] = (baseVerdicts[baseLabel] ?? 0) + 1;
      currentVerdicts[currentLabel] = (currentVerdicts[currentLabel] ?? 0) + 1;
      transitions[transition] = (transitions[transition] ?? 0) + 1;
      return {
        entity: root.entity,
        kboId: player?.kboId ?? null,
        rosterBirthDate: player?.birthDate ?? null,
        canonical: root.canonical,
        fetchedAt: root.fetchedAt,
        documentSha256: sha256(root.text),
        base: baseLabel,
        current: currentLabel,
        transition,
      };
    });

  const baseAssigned = rows.filter((row) => row.base.startsWith("assigned")).length;
  const currentAssigned = rows.filter((row) => row.current.startsWith("assigned")).length;
  fs.writeFileSync(
    "scripts/qa/fixtures/corpus-identity-census.json",
    `${JSON.stringify({
      note: "실 corpus 선수 루트문서 전건 신원 재판정(base↔current). build: scripts/qa/corpus-identity-census.ts",
      corpusFile: corpusPath.split("/").pop(),
      corpusSha256: corpusHash.digest("hex"),
      corpusPhysicalLines: physicalLines,
      rosterFileSha256: sha256(rosterRaw),
      rosterPlayers: roster.length,
      baseIdentitySha256: base.sha,
      currentIdentitySha256: currentSha,
      playerRootDocuments: rows.length,
      baseAssigned,
      currentAssigned,
      baseVerdicts,
      currentVerdicts,
      transitions,
      rows,
    }, null, 1)}\n`,
  );
  console.log(`census: ${rows.length} roots · assigned ${baseAssigned} → ${currentAssigned}`);
  console.log(`transitions ${JSON.stringify(transitions)}`);
}

void main();
