/**
 * `scripts/qa/fixtures/corpus-identity-documents.json` 생성기.
 *
 * ⚠️ 왜 발췌하는가, 그리고 왜 발췌가 안전한가.
 *   실 corpus(`namu-corpus-complete.jsonl`, 175MB)는 repo에 넣을 수 없다. 그렇다고 손으로 지어낸
 *   fixture를 "실측"이라 부르면 게이트가 실제 문서 모양과 무관해진다 — 이 PR 이전 판이 정확히
 *   그랬고, 그래서 listed 레이아웃 411건을 통째로 못 봤다.
 *
 *   그래서 **실 corpus 원문에서 기계적으로 발췌**하되, 발췌본과 원문의 판정이 **완전히 같을 때만**
 *   fixture로 채택한다(아래 assertSameVerdict). 다르면 그 문서는 발췌하지 않고 실패한다.
 *
 * 실행(로컬, T7 corpus 필요):
 *   CORPUS=/Volumes/T7-Dev/reviews/runtime/namu-corpus-complete.jsonl \
 *   npx tsx scripts/qa/build-corpus-identity-fixtures.ts
 */
import fs from "node:fs";
import readline from "node:readline";

import { verifyCorpusPlayerIdentity, formatRosterBirthDateForDocument } from "../../src/lib/baseball-qa/rag/corpus-identity";

type Roster = { name: string; kboId: string; birthDate?: string };
const roster: Roster[] = JSON.parse(
  fs.readFileSync("src/lib/constants/players-roster.json", "utf8"),
);
const byName = new Map<string, Roster[]>();
for (const player of roster) byName.set(player.name, [...(byName.get(player.name) ?? []), player]);

/** fixture로 고정할 문서. 선정 근거는 fixture 파일의 `why`에 함께 남는다. */
const WANTED: Readonly<Record<string, string>> = {
  // ── 생년 불일치 전건 9명 (2026-08-09 실 corpus 전수 결과) ──
  "최형우": "생년 불일치 · 문서가 로스터 등록일을 각주로 명시(음력) → 통과",
  "장성우": "생년 불일치 · 문서가 로스터 등록일을 각주로 명시(출생신고 지연) → 통과",
  "김태혁": "생년 불일치 · 문서에 로스터 등록일이 없음 → 격리 유지(근거 없는 구제 금지)",
  "박찬호": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  "이진영": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  "이호준": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  "최윤석": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  "권현규": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  "김민범": "생년 불일치 · 동명의 다른 인물 문서 → 거부",
  // ── 레이아웃 양쪽 경계 ──
  "김도영": "inline 레이아웃 정상 통과",
  "양의지": "inline 레이아웃 · 분류 428자(종전 300자 상한이 잘라 거부하던 문서)",
  "강준서": "listed 레이아웃 정상 통과",
  "김헌곤": "listed 레이아웃 정상 통과 · 라벨 마지막이 별명(`곤장님`)",
  // ── 음성(거부/격리) 축 ──
  "오스틴": "inline 동음이의 문서 → 격리",
  "강백호": "inline 동음이의 문서 · 본문에 `야구선수` 포함 → 판정 순서가 막아야 함",
  "레이예스": "inline 성씨 문서 · 본문 후반에 야구선수 링크 다수 → 분류만 봐야 거부됨",
  "박상원": "listed 동음이의 문서 → 격리",
  "김진수": "listed · 축구선수 문서 → 거부",
};

const HEAD_CHARS = 4_000;

/** 발췌: 문서 머리 + (머리 밖에 있는) 로스터 등록일이 적힌 줄. */
function excerpt(text: string, rosterBirthDate: string | undefined): string {
  const head = text.slice(0, HEAD_CHARS);
  const needle = rosterBirthDate ? formatRosterBirthDateForDocument(rosterBirthDate) : undefined;
  if (!needle || head.includes(needle)) return head;
  const tailLines = text.split("\n").filter((line) => line.includes(needle));
  if (tailLines.length === 0) return head;
  return `${head}\n${tailLines.join("\n")}`;
}

function assertSameVerdict(
  entity: string,
  full: string,
  reduced: string,
  player: Roster | undefined,
  title: string,
): void {
  const args = {
    rosterBirthYear: player?.birthDate?.slice(0, 4),
    rosterBirthDate: player?.birthDate,
    seedName: entity,
    documentTitle: title,
  };
  const a = JSON.stringify(verifyCorpusPlayerIdentity({ text: full, ...args }));
  const b = JSON.stringify(verifyCorpusPlayerIdentity({ text: reduced, ...args }));
  if (a !== b) {
    throw new Error(`발췌가 판정을 바꿨다 (${entity}): full=${a} reduced=${b}`);
  }
}

async function main(): Promise<void> {
  const corpusPath = process.env.CORPUS;
  if (!corpusPath) throw new Error("CORPUS 환경변수에 corpus jsonl 경로를 지정해야 한다");
  const latest = new Map<string, { entity: string; title: string; canonical: string; fetchedAt: string; text: string }>();
  const stream = readline.createInterface({
    input: fs.createReadStream(corpusPath),
    crlfDelay: Infinity,
  });
  for await (const line of stream) {
    if (line.trim().length === 0) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; }
    if (record.kind !== "player" || record.depth !== 1) continue;
    if (!(record.entity in WANTED)) continue;
    const previous = latest.get(record.entity);
    if (!previous || previous.fetchedAt < record.fetchedAt) {
      latest.set(record.entity, {
        entity: record.entity, title: record.title, canonical: record.canonical,
        fetchedAt: record.fetchedAt, text: record.text,
      });
    }
  }
  const missing = Object.keys(WANTED).filter((name) => !latest.has(name));
  if (missing.length > 0) throw new Error(`corpus에 없는 문서: ${missing.join(", ")}`);

  const documents = [...latest.values()].sort((a, b) => a.entity.localeCompare(b.entity, "ko")).map((doc) => {
    const candidates = byName.get(doc.entity) ?? [];
    const player = candidates.length === 1 ? candidates[0] : undefined;
    const text = excerpt(doc.text, player?.birthDate);
    assertSameVerdict(doc.entity, doc.text, text, player, doc.title);
    return {
      entity: doc.entity,
      why: WANTED[doc.entity],
      kboId: player?.kboId,
      rosterBirthDate: player?.birthDate,
      title: doc.title,
      canonical: doc.canonical,
      fetchedAt: doc.fetchedAt,
      sourceLength: doc.text.length,
      text,
    };
  });
  fs.writeFileSync(
    "scripts/qa/fixtures/corpus-identity-documents.json",
    `${JSON.stringify({
      note: "실 corpus 원문 발췌. 발췌본과 원문의 신원 판정이 동일함을 build 스크립트가 검증한다.",
      generatedFrom: corpusPath.split("/").pop(),
      documents,
    }, null, 1)}\n`,
  );
  console.log(`fixtures written: ${documents.length} documents`);
}

void main();
