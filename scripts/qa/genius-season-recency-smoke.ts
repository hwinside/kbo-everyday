/**
 * 야잘알봇 **시즌 인식 랭킹** 계약 게이트
 * (하린아빠 2026-08-28 "한화 팀 나무위키에서 확인 가능할텐데").
 *
 * ── 🔴 이 게이트가 생긴 경위 = 내 오진 정정 ────────────────────────────────
 *   나는 `한화 감독`·`롯데 선발진`·`NC 04번` 을 "정본이 없어 못 답하는 질문"으로
 *   분류하고 "현재 확인 불가로 닫자"고 제안했다. 하린아빠 지적으로 프로덕션 코퍼스에
 *   **실제 검색 RPC 를 태워보니 틀렸다** — 근거는 있었고, 검색이 연도를 안 본 것이다:
 *     · `롯데 가을야구 갈 수 있을까?` top1 = `롯데 자이언츠/2025년/9월`
 *       → "이젠 자력으로 가을야구 진출 가능성은 거의 사라진 상황"
 *     · `롯데 투수 선발진을 알려줘`    top1~3 = `/2023년`·`/2025년`·`/2024년/총평`
 *     · `엔씨 04번 누구야?`           top1 = `NC 다이노스/등번호` → `04 … 조하선(2024~)`
 *       (봇 답변이 근거와 일치했다 — 이건 애초에 결함이 아니었다)
 *   즉 team_rag 실패의 상당수는 환각이 아니라 **과거 시즌 문서의 정확한 재서술**이다.
 *   고칠 지점은 생성(프롬프트)이 아니라 **검색(랭킹)** 이다.
 *
 * ── 검증 축 ────────────────────────────────────────────────────────────────
 *   S1 `parseEvidenceSeason` — 실측 경로 형태에서 시즌을 뽑는다
 *   S2 판정 입력이 **경로**다 — 본문의 `1999년 우승` 을 문서 시점으로 오인하지 않는다
 *   S3 `seasonRecencyWeight` — 현재>과거, 연도 없음 중립, 미래 중립, 하한 준수
 *   S4 **재점수화이지 hard sort 가 아니다** — 과거 문서가 유사도로 분명히 앞서면 살아남는다
 *   S5 종단 랭킹 — 같은 내용의 2025 문서 vs 2026 문서면 2026 이 top 으로 올라온다
 *   S6 `currentSeason` 미주입 시 **종전 순서와 동일**(신규 축이 기본 거동을 안 바꾼다)
 *   S7 배선 — `searchRag` 가 현재 시즌을 넘긴다 + `now` 가 주입 가능한 seam 이다
 *
 * 검증력 증명은 `genius-season-recency-mutations.mjs` 가 소스 변조로 수행한다.
 *
 * 실행: npm run qa:genius-season-recency
 */
import { readFileSync } from "node:fs";
import {
  parseEvidenceSeason,
  rankEvidenceByQuery,
  seasonRecencyWeight,
  SEASON_RECENCY_CURRENT_BOOST,
  SEASON_RECENCY_DECAY_PER_YEAR,
  SEASON_RECENCY_MIN_WEIGHT,
  type RagEvidence,
} from "../../src/lib/baseball-qa/rag/retrieve";

const SELFTEST = process.argv.includes("--selftest");
let failures = 0;
function check(name: string, ok: boolean, detail?: string) {
  if (ok) console.log(`PASS ${name}`);
  else { failures++; console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}

const stripComments = (text: string) => text
  .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
  .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));

const CURRENT_SEASON = 2026;

// ── 벡터 하니스 ────────────────────────────────────────────────────────────
// 유사도를 **제어 가능**하게 만들어야 "가중치가 순서를 뒤집었다 / 못 뒤집었다"를 가른다.
// 단위벡터 2차원: 질문과 각도가 작을수록 코사인이 크다.
const QUERY = [1, 0];
const unit = (cos: number): number[] => [cos, Math.sqrt(Math.max(0, 1 - cos * cos))];

function evidence(
  sectionPath: string,
  cos: number,
  extra: Partial<RagEvidence> = {},
): RagEvidence & { embedding: number[] } {
  return {
    content: `${sectionPath} 근거 본문입니다. 최소 길이를 넘기기 위한 문장을 포함합니다.`,
    pageTitle: "롯데 자이언츠",
    canonicalUrl: "https://namu.wiki/w/롯데 자이언츠",
    revision: "1",
    sectionPath,
    asOf: "2026-08-06",
    sourceGrade: "tier2",
    sourceKind: "namu_document",
    ...extra,
    embedding: unit(cos),
  } as RagEvidence & { embedding: number[] };
}

function main() {
  const retrieve = stripComments(
    readFileSync(new URL("../../src/lib/baseball-qa/rag/retrieve.ts", import.meta.url), "utf8"));
  const server = stripComments(
    readFileSync(new URL("../../src/lib/baseball-qa/server.ts", import.meta.url), "utf8"));

  // ── S1. 실측 경로 형태에서 시즌 추출 ─────────────────────────────────────
  //    전부 2026-08-28 프로덕션 `genius_rag_serving_chunks.section_path` 실측 형태다.
  const seasonCases: ReadonlyArray<[string, number | null]> = [
    ["롯데 자이언츠/2025년/9월", 2025],
    ["롯데 자이언츠/2023년", 2023],
    ["롯데 자이언츠/2024년/총평", 2024],
    ["한화 이글스/2017년", 2017],
    ["2026 신한 SOL KBO 리그/삼성 라이온즈 vs 한화 이글스 제1차전", 2026],
    // 연도 없는 상위 문서 — 구단 소개·역대 감독표·등번호가 여기 있다(중립이어야 한다).
    ["한화 이글스", null],
    ["NC 다이노스/등번호", null],
    ["NC 다이노스/선수단", null],
    ["한화 이글스/역사", null],
    // 🔴 실측 다년 경로 (전체 613개 distinct 경로 중 **유일**, 2026-08-28 전수 조회).
    //   `Math.max` vs `Math.min` 이 갈리는 유일한 무대라 이 케이스가 없으면 m2 변이가
    //   무증상이 된다 — 픽스처가 경계를 실제로 걸쳐야 mutation 이 결함이 된다(M90).
    ["NC 다이노스/2011~2012년", 2012],
  ];
  for (const [path, expected] of seasonCases) {
    const got = parseEvidenceSeason({ sectionPath: path, pageTitle: "" });
    check(`S1 시즌 추출 — ${path} → ${expected}`, got === expected, `실제 ${got}`);
  }

  // ── S2. 판정 입력은 경로다 (본문 연도 무시) ──────────────────────────────
  //    🔴 본문에서 연도를 긁으면 `1999년 한국시리즈 우승` 서술이 문서 시점이 된다.
  //    실측 무대: 경로엔 연도가 없고 본문에만 연도가 있는 청크가 4개 구단에서 362건이다
  //    (예: `한화 이글스` 본문의 `1986년 3월 8일 빙그레 이글스라는 이름으로 창단`).
  //    본문을 판정에 쓰면 이 362건이 전부 1980~90년대 문서로 강등된다.
  const bodyYearRow = {
    sectionPath: "한화 이글스",
    pageTitle: "한화 이글스",
    content: "1986년 3월 8일 빙그레 이글스라는 이름으로 창단했으며, 1999년 한국시리즈에서 우승했다.",
  } as unknown as Pick<RagEvidence, "sectionPath" | "pageTitle">;
  check("S2 본문 연도는 판정에 안 쓴다", parseEvidenceSeason(bodyYearRow) === null,
    String(parseEvidenceSeason(bodyYearRow)));

  // ── S3. 가중치 곡선 ──────────────────────────────────────────────────────
  check("S3 연도 없음 → 중립 1.0", seasonRecencyWeight(null, CURRENT_SEASON) === 1);
  check("S3b 현재 시즌 → boost",
    seasonRecencyWeight(CURRENT_SEASON, CURRENT_SEASON) === SEASON_RECENCY_CURRENT_BOOST);
  check("S3c 미래 연도 → 중립", seasonRecencyWeight(CURRENT_SEASON + 1, CURRENT_SEASON) === 1);
  check("S3d 직전 시즌 < 현재 시즌",
    seasonRecencyWeight(CURRENT_SEASON - 1, CURRENT_SEASON)
    < seasonRecencyWeight(CURRENT_SEASON, CURRENT_SEASON));
  check("S3e 단조 감소 (오래될수록 낮다)",
    seasonRecencyWeight(2024, CURRENT_SEASON) > seasonRecencyWeight(2020, CURRENT_SEASON));
  check("S3f 하한 준수 — 아무리 오래돼도 0 이 아니다",
    seasonRecencyWeight(1982, CURRENT_SEASON) === SEASON_RECENCY_MIN_WEIGHT
    && SEASON_RECENCY_MIN_WEIGHT > 0);
  check("S3g 감쇠율이 양수", SEASON_RECENCY_DECAY_PER_YEAR > 0);

  // ── S5. 종단 랭킹 — 비슷하면 최신이 앞선다 ───────────────────────────────
  //    실측 재현: `롯데 가을야구 갈 수 있을까?` 에서 2025/9월 문서가 top1 이었다.
  //    두 문서의 유사도를 **2025 가 근소하게 높게** 두어 종전 결함을 재현한 뒤,
  //    시즌 가중이 순서를 바로잡는지 본다.
  const rows = [
    evidence("롯데 자이언츠/2025년/9월", 0.82),
    evidence("롯데 자이언츠/2026년/8월", 0.80),
  ];
  const withoutSeason = rankEvidenceByQuery([...rows], QUERY);
  check("S5 종전 거동 재현 — 과거 문서가 top1", withoutSeason[0].sectionPath.includes("2025년"),
    withoutSeason[0].sectionPath);
  const withSeason = rankEvidenceByQuery([...rows], QUERY, undefined, undefined, CURRENT_SEASON);
  check("S5b 시즌 가중 후 — 현재 시즌 문서가 top1", withSeason[0].sectionPath.includes("2026년"),
    withSeason[0].sectionPath);

  // ── S4. 재점수화이지 hard sort 가 아니다 ─────────────────────────────────
  //    🔴 유저가 과거를 명시하면(`2018년 한화 어땠어?`) 그 문서가 유사도에서 분명히
  //    앞선다. 그때 시즌 가중이 뒤집으면 질문에 답할 근거가 사라진다.
  const farApart = [
    evidence("롯데 자이언츠/2018년", 0.95),
    evidence("롯데 자이언츠/2026년/8월", 0.50),
  ];
  const ranked = rankEvidenceByQuery([...farApart], QUERY, undefined, undefined, CURRENT_SEASON);
  check("S4 유사도가 분명히 앞서면 과거 문서가 살아남는다",
    ranked[0].sectionPath.includes("2018년"), ranked[0].sectionPath);
  check("S4b 과거 문서를 탈락시키지 않는다 (전량 보존)", ranked.length === farApart.length,
    `${ranked.length}/${farApart.length}`);
  // 🔴 S4d: 최대 스윙비 상한을 **수치로 고정**한다.
  //   초안은 boost 1.35 / 하한 0.6 (스윙 2.25배)이었고, 그 폭에서는 유사도 0.95 문서가
  //   0.50 문서에 밀렸다 — 이름만 재점수화지 사실상 hard sort 였다(S4 가 잡았다).
  //   상한을 assertion 으로 박아두지 않으면 다음 사람이 "조금만 더 세게"로 되돌린다.
  const maxSwing = SEASON_RECENCY_CURRENT_BOOST / SEASON_RECENCY_MIN_WEIGHT;
  check("S4d 최대 스윙비 ≤ 1.5 (재점수화 상한)", maxSwing <= 1.5, `swing=${maxSwing.toFixed(3)}`);

  // 연도 없는 문서는 중립이라 유사도 순서를 그대로 지킨다 — 역대 감독표가 죽으면 안 된다.
  const neutralRows = [
    evidence("한화 이글스", 0.90, { pageTitle: "한화 이글스" }),
    evidence("한화 이글스/2020년", 0.85, { pageTitle: "한화 이글스" }),
  ];
  const neutralRanked = rankEvidenceByQuery([...neutralRows], QUERY, undefined, undefined, CURRENT_SEASON);
  check("S4c 연도 없는 상위 문서(역대 감독표)는 중립 유지",
    neutralRanked[0].sectionPath === "한화 이글스", neutralRanked[0].sectionPath);

  // ── S6. 미주입 시 종전 거동 동일 ─────────────────────────────────────────
  //    신규 축이 기본 거동을 바꾸면 이 PR 밖의 모든 RAG 경로가 함께 흔들린다.
  const mixed = [
    evidence("롯데 자이언츠/2019년", 0.70),
    evidence("롯데 자이언츠/2026년/8월", 0.66),
    evidence("롯데 자이언츠", 0.60),
  ];
  const legacy = rankEvidenceByQuery([...mixed], QUERY);
  const legacyExplicitUndefined = rankEvidenceByQuery([...mixed], QUERY, undefined, undefined, undefined);
  check("S6 currentSeason 미주입 → 순서 동일",
    JSON.stringify(legacy) === JSON.stringify(legacyExplicitUndefined));
  check("S6b 미주입 순서가 순수 유사도 순서",
    legacy.map((r) => r.sectionPath).join("|")
    === "롯데 자이언츠/2019년|롯데 자이언츠/2026년/8월|롯데 자이언츠",
    legacy.map((r) => r.sectionPath).join("|"));

  // ── S7. 배선 ─────────────────────────────────────────────────────────────
  //    존재 확인이 아니라 **현재 시즌이 실제로 넘어가는지** + 시각이 주입 가능한지.
  check("S7 searchRag 가 현재 시즌을 전달", /kstSeasonOf\(now\(\)\)/.test(server));
  check("S7b now 가 주입 가능한 seam", /now:\s*\(\)\s*=>\s*number\s*=\s*Date\.now/.test(server));
  check("S7c searchSourcePriorityCandidates 가 currentSeason 을 하류로 전달",
    /rankEvidenceByQuery\(\s*\[\.\.\.wikipediaRows,\s*\.\.\.namuRows\],\s*queryVector,\s*weightFor,\s*project,\s*currentSeason,?\s*\)/
      .test(retrieve));
  check("S7d 시즌 가중이 랭킹 점수에 곱해진다",
    /base \* weight \* seasonWeight/.test(retrieve));

  if (SELFTEST) {
    console.log("\n── selftest (판정 경계) ──");
    check("selftest A 2025 vs 2026 boost 차",
      seasonRecencyWeight(2026, 2026) > seasonRecencyWeight(2025, 2026));
    check("selftest B null 은 boost 가 아니다",
      seasonRecencyWeight(null, 2026) < seasonRecencyWeight(2026, 2026));
    check("selftest C 하한 아래로 내려가지 않는다",
      seasonRecencyWeight(1900, 2026) >= SEASON_RECENCY_MIN_WEIGHT);
  }

  console.log(`\n${failures === 0 ? "GREEN" : "RED"} — failures=${failures}`);
  if (failures > 0) process.exit(1);
}

main();
