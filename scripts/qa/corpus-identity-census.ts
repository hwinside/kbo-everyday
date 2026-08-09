/**
 * 실 corpus 선수 루트문서 **전건 신원 재판정** — 재현 가능한 감사 산출물.
 *
 * ⚠️ 이 파일이 지금 형태가 된 경위 (삼순 NO-GO 누적)
 *   1차: "238→242" 처럼 숫자만 보고 → 재현 불가.
 *   2차: 현재 verdict 만 담음 → before/after 와 전이 대상을 알 수 없음.
 *   3차: base 를 넣긴 했는데 **PR base 가 아니라 이 PR 의 중간 커밋**을 썼다.
 *        그래서 `156→395` 는 "main→현재" 가 아니라 "중간 broken exact→현재" 였고,
 *        생성기 주석엔 `baseRef 시점` 이라고 적어 증거의 의미까지 틀렸다.
 *
 * 그래서 지금은 **비교 대상을 명시적으로 두 개**로 나눈다:
 *   `base`     = PR base 커밋(= merge-base, main)의 구현. **이 PR 의 순효과**를 말한다.
 *   `previous` = 이 PR 안의 직전 exact 구현. 리뷰 라운드 사이의 변화만 본다(선택).
 * 두 비교를 한 필드에 섞으면 어떤 효과를 말하는지 알 수 없어진다.
 *
 * 산출물에 고정하는 것:
 *   - **입력 지문**: corpus SHA-256, 물리 행 수, 로스터 파일 SHA-256.
 *     fixture 파일(`corpus-identity-documents.json`)도 같은 corpus SHA 를 갖고 있어야
 *     두 artifact 가 같은 입력에서 나왔음이 증명된다(smoke 가 이 일치를 검사한다).
 *   - **비교 대상 지문**: base commit SHA + base 구현 파일 SHA(그리고 previous 도 동일하게).
 *     커밋 SHA 가 없으면 "어느 base 냐" 를 사후에 확인할 수 없다 — 3차 NO-GO 의 원인이다.
 *   - **행별 base / current / transition** + 문서 원문 SHA-256.
 *     base 판정은 그 시점 구현을 **실제로 로드해서 실행**한다(재서술이 아니다).
 *
 * 실행(로컬, T7 corpus 필요):
 *   BASE_COMMIT=$(git merge-base HEAD origin/main)
 *   git show "$BASE_COMMIT":src/lib/baseball-qa/rag/corpus-identity.ts > /tmp/base-identity.ts
 *   CORPUS=/Volumes/T7-Dev/reviews/runtime/namu-corpus-complete.jsonl \
 *   BASE_COMMIT="$BASE_COMMIT" BASE_IDENTITY=/tmp/base-identity.ts \
 *   [PREVIOUS_COMMIT=<sha> PREVIOUS_IDENTITY=/tmp/prev-identity.ts] \
 *   npx tsx scripts/qa/corpus-identity-census.ts
 *
 * ⚠️ corpus(175MB)는 repo 에 없으므로 이 스크립트는 CI 게이트가 아니다. 산출물만 커밋되고,
 *   회귀 게이트는 이 산출물과 fixture 로 `qa:baseball-corpus-identity` 가 담당한다.
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

/** 판정 → 감사 라벨. 현재 구현은 구제 여부까지 구분한다. */
function currentLabelOf(verdict: CorpusIdentityVerdict, rosterCandidates: number): string {
  if (rosterCandidates !== 1) return "roster_name_ambiguous";
  if (!verdict.ok) return `${verdict.status}:${verdict.reason}`;
  return verdict.birthEvidence === "roster_date_stated_in_document" ? "assigned_birth_rescued" : "assigned";
}

/**
 * 이전 버전 구현은 `birthEvidence` 가 없다(그 시점엔 구제 개념 자체가 없거나 형태가 달랐다).
 * 그 시점 계약대로 `assigned` 로만 읽는다 — 없는 필드를 있는 것처럼 해석하지 않는다.
 */
function historicLabelOf(verdict: CorpusIdentityVerdict, rosterCandidates: number): string {
  if (rosterCandidates !== 1) return "roster_name_ambiguous";
  if (!verdict.ok) return `${verdict.status}:${verdict.reason}`;
  return "assigned";
}

async function loadIdentity(identityPath: string): Promise<{ fn: IdentityFn; sha: string }> {
  const source = fs.readFileSync(identityPath);
  // tsx 로 실행되므로 .ts 를 그대로 import 할 수 있다. 그 시점 구현을 **실제로 실행**해서
  // 판정을 만든다 — 손으로 옮겨 적으면 그게 또 재현 불가능한 주장이 된다.
  const loaded = (await import(path.resolve(identityPath))) as { verifyCorpusPlayerIdentity: IdentityFn };
  if (typeof loaded.verifyCorpusPlayerIdentity !== "function") {
    throw new Error(`identity 모듈에 verifyCorpusPlayerIdentity 가 없다: ${identityPath}`);
  }
  return { fn: loaded.verifyCorpusPlayerIdentity, sha: sha256(source) };
}

function requireCommitSha(value: string | undefined, name: string): string {
  if (!value || !/^[0-9a-f]{40}$/.test(value)) {
    throw new Error(`${name} 에 40자리 커밋 SHA 를 지정해야 한다 (받은 값: ${value ?? "없음"})`);
  }
  return value;
}

async function main(): Promise<void> {
  const corpusPath = process.env.CORPUS;
  if (!corpusPath) throw new Error("CORPUS 환경변수에 corpus jsonl 경로를 지정해야 한다");
  const baseIdentityPath = process.env.BASE_IDENTITY;
  if (!baseIdentityPath) throw new Error("BASE_IDENTITY 환경변수에 PR base 의 corpus-identity.ts 경로를 지정해야 한다");
  const baseCommit = requireCommitSha(process.env.BASE_COMMIT, "BASE_COMMIT");
  const previousIdentityPath = process.env.PREVIOUS_IDENTITY;
  const previousCommit = previousIdentityPath
    ? requireCommitSha(process.env.PREVIOUS_COMMIT, "PREVIOUS_COMMIT")
    : undefined;

  const rosterRaw = fs.readFileSync("src/lib/constants/players-roster.json");
  const roster: Roster[] = JSON.parse(rosterRaw.toString("utf8"));
  const byName = new Map<string, Roster[]>();
  for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);

  const base = await loadIdentity(baseIdentityPath);
  const previous = previousIdentityPath ? await loadIdentity(previousIdentityPath) : undefined;
  const currentSha = sha256(fs.readFileSync("src/lib/baseball-qa/rag/corpus-identity.ts"));
  if (base.sha === currentSha) {
    throw new Error("base 와 current 구현이 동일하다 — before/after 대조가 성립하지 않는다");
  }

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
    const seen = latest.get(key);
    if (!seen || seen.fetchedAt < record.fetchedAt) {
      latest.set(key, {
        entity: record.entity, title: record.title, canonical: record.canonical,
        fetchedAt: record.fetchedAt, text: record.text,
      });
    }
  }

  const baseVerdicts: Record<string, number> = {};
  const currentVerdicts: Record<string, number> = {};
  const transitions: Record<string, number> = {};
  const previousTransitions: Record<string, number> = {};
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
      const baseLabel = historicLabelOf(base.fn(input), candidates.length);
      const currentLabel = currentLabelOf(verifyCorpusPlayerIdentity(input), candidates.length);
      const previousLabel = previous ? historicLabelOf(previous.fn(input), candidates.length) : undefined;

      const classify = (from: string, to: string): string => {
        const fromAssigned = from.startsWith("assigned");
        const toAssigned = to.startsWith("assigned");
        if (fromAssigned === toAssigned) return fromAssigned ? "kept_assigned" : "kept_excluded";
        return toAssigned ? "gained" : "lost";
      };
      const transition = classify(baseLabel, currentLabel);
      baseVerdicts[baseLabel] = (baseVerdicts[baseLabel] ?? 0) + 1;
      currentVerdicts[currentLabel] = (currentVerdicts[currentLabel] ?? 0) + 1;
      transitions[transition] = (transitions[transition] ?? 0) + 1;
      let previousTransition: string | undefined;
      if (previousLabel !== undefined) {
        previousTransition = classify(previousLabel, currentLabel);
        previousTransitions[previousTransition] = (previousTransitions[previousTransition] ?? 0) + 1;
      }

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
        ...(previousLabel === undefined ? {} : { previous: previousLabel, previousTransition }),
      };
    });

  const baseAssigned = rows.filter((row) => row.base.startsWith("assigned")).length;
  const currentAssigned = rows.filter((row) => row.current.startsWith("assigned")).length;
  const previousAssigned = previous
    ? rows.filter((row) => String((row as any).previous ?? "").startsWith("assigned")).length
    : undefined;

  fs.writeFileSync(
    "scripts/qa/fixtures/corpus-identity-census.json",
    `${JSON.stringify({
      note: "실 corpus 선수 루트문서 전건 신원 재판정. base = PR base 커밋 구현(이 PR 의 순효과). build: scripts/qa/corpus-identity-census.ts",
      corpusFile: corpusPath.split("/").pop(),
      corpusSha256: corpusHash.digest("hex"),
      corpusPhysicalLines: physicalLines,
      rosterFileSha256: sha256(rosterRaw),
      rosterPlayers: roster.length,
      // ⚠️ base = PR base(merge-base) 커밋. 이 PR 의 중간 커밋이 아니다.
      baseCommit,
      baseIdentitySha256: base.sha,
      currentIdentitySha256: currentSha,
      playerRootDocuments: rows.length,
      baseAssigned,
      currentAssigned,
      baseVerdicts,
      currentVerdicts,
      transitions,
      // 선택: 이 PR 안의 직전 exact 와의 비교. base 비교와 절대 섞지 않는다.
      ...(previous
        ? {
          previousCommit,
          previousIdentitySha256: previous.sha,
          previousAssigned,
          previousTransitions,
        }
        : {}),
      rows,
    }, null, 1)}\n`,
  );
  console.log(`census: ${rows.length} roots · base(${baseCommit.slice(0, 9)}) ${baseAssigned} → current ${currentAssigned}`);
  console.log(`transitions ${JSON.stringify(transitions)}`);
  if (previous) {
    console.log(`previous(${previousCommit?.slice(0, 9)}) ${previousAssigned} → current ${currentAssigned} · ${JSON.stringify(previousTransitions)}`);
  }
}

void main();
