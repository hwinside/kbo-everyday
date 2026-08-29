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
  resolveSeasonTarget,
  searchSourcePriorityCandidates,
  seasonLanePlan,
  seasonRecencyWeight,
  seasonTargetWeight,
  SEASON_RECENCY_CURRENT_BOOST,
  SEASON_RECENCY_DECAY_PER_YEAR,
  SEASON_RECENCY_MIN_WEIGHT,
  RAG_EVIDENCE_LIMIT,
  type RagEvidence,
  type RagEvidenceCandidate,
  type SeasonLaneMode,
  type SeasonTarget,
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

async function main() {
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
    const got = parseEvidenceSeason({ sectionPath: path, pageTitle: "", canonicalUrl: "" });
    check(`S1 시즌 추출 — ${path} → ${expected}`, got === expected, `실제 ${got}`);
  }

  // 🔴 S1b 문서 identity 우선 (삼순 2026-08-28). `pageTitle`·`canonicalUrl` 이 문서의
  //   정체다 — 하위 section 에 다른 연도가 스쳐도 상위 문서 시즌을 덮으면 안 된다.
  check("S1b identity(pageTitle)가 section 을 덮는다",
    parseEvidenceSeason({
      pageTitle: "한화 이글스/2026년",
      sectionPath: "3.2. 2017년 대비 개선점",
      canonicalUrl: "",
    }) === 2026);
  check("S1c identity 안 다년 표기는 최신 채택",
    parseEvidenceSeason({
      pageTitle: "NC 다이노스/2011~2012년", sectionPath: "", canonicalUrl: "",
    }) === 2012);
  check("S1d canonicalUrl(퍼센트 인코딩)에서도 연도를 읽는다",
    parseEvidenceSeason({
      pageTitle: "", sectionPath: "",
      canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4/2024%EB%85%84",
    }) === 2024);

  // ── S2. 판정 입력은 경로다 (본문 연도 무시) ──────────────────────────────
  //    🔴 본문에서 연도를 긁으면 `1999년 한국시리즈 우승` 서술이 문서 시점이 된다.
  //    실측 무대: 경로엔 연도가 없고 본문에만 연도가 있는 청크가 4개 구단에서 362건이다
  //    (예: `한화 이글스` 본문의 `1986년 3월 8일 빙그레 이글스라는 이름으로 창단`).
  //    본문을 판정에 쓰면 이 362건이 전부 1980~90년대 문서로 강등된다.
  const bodyYearRow = {
    sectionPath: "한화 이글스",
    pageTitle: "한화 이글스",
    canonicalUrl: "https://namu.wiki/w/%ED%95%9C%ED%99%94%20%EC%9D%B4%EA%B8%80%EC%8A%A4",
    content: "1986년 3월 8일 빙그레 이글스라는 이름으로 창단했으며, 1999년 한국시리즈에서 우승했다.",
  } as unknown as Pick<RagEvidence, "sectionPath" | "pageTitle" | "canonicalUrl">;
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

  // ── S5. 종단 — 올해 문서가 **LLM 에 도달**한다 ───────────────────────────
  //
  //    🔴 계약이 바뀌었다 (삼순 2026-08-29 5차 이후). 종전 S5b 는 "시즌 가중 후 올해
  //    문서가 top1" 이었는데, 그건 **어휘 목록으로 '현재를 물었다'를 맞혔을 때만** 성립한다.
  //    그 판정이 열린 집합이라 목록을 없앴고, 없애니 순위 조작의 근거도 함께 사라졌다.
  //
  //    새 계약: 순위를 조작해 답을 정하지 않는다. 대신 **양쪽을 다 보여준다** —
  //    올해 문서와 무연도 문서를 근거 집합에 예약해 넣고, 어느 쪽이 답인지는 근거 시점
  //    주석(`문서 시점 · 수집일 · 현재성`)을 보는 LLM 이 정한다.
  //    실측 재현(`롯데 가을야구 갈 수 있을까?`)에서 진짜 문제는 top1 이 아니라
  //    **올해 문서가 근거 4~6건 안에 아예 없었다**는 것이었다.
  const rows = [
    evidence("롯데 자이언츠/2025년/9월", 0.82),
    evidence("롯데 자이언츠/2026년/8월", 0.80),
  ];
  const withoutSeason = rankEvidenceByQuery([...rows], QUERY);
  check("S5 유사도 순서는 그대로 (순위 조작 없음)",
    withoutSeason[0].sectionPath.includes("2025년"), withoutSeason[0].sectionPath);
  const withSeason = rankEvidenceByQuery([...rows], QUERY, undefined, undefined, CURRENT_SEASON);
  check("S5b 시즌 축을 켜도 순서를 뒤집지 않는다 (boost 폐기 확인)",
    withSeason[0].sectionPath.includes("2025년"), withSeason[0].sectionPath);
  check("S5b2 그래도 올해 문서는 근거에 남는다",
    withSeason.some((r) => r.sectionPath.includes("2026년")),
    withSeason.map((r) => r.sectionPath).join("|"));

  // 🔴 S5c 핵심 축 — 후보가 cap 보다 많을 때 **올해 문서가 절단으로 사라지지 않는다**.
  //   과거 시즌 문서가 유사도 상위를 독점하는 것이 실측에서 관찰된 그 상황이다.
  const crowded = [
    evidence("롯데 자이언츠/2025년/9월", 0.90),
    evidence("롯데 자이언츠/2025년/8월", 0.89),
    evidence("롯데 자이언츠/2024년/총평", 0.88),
    evidence("롯데 자이언츠/2023년", 0.87),
    evidence("롯데 자이언츠/2022년", 0.86),
    evidence("롯데 자이언츠/2021년", 0.85),
    evidence("롯데 자이언츠/2026년/8월", 0.60),          // 올해 — 유사도 최하위
    evidence("롯데 자이언츠", 0.55, { pageTitle: "롯데 자이언츠" }), // 무연도 상위문서
  ];
  const crowdedPlain = rankEvidenceByQuery([...crowded], QUERY);
  check("S5c 종전 거동 재현 — 올해 문서가 절단 밖으로 사라진다",
    !crowdedPlain.some((r) => r.sectionPath.includes("2026년")),
    crowdedPlain.map((r) => r.sectionPath).join("|"));
  const crowdedDiverse = rankEvidenceByQuery(
    [...crowded], QUERY, undefined, undefined, CURRENT_SEASON);
  check("S5c2 시점 다양성 — 올해 문서가 근거에 도달한다",
    crowdedDiverse.some((r) => r.sectionPath.includes("2026년")),
    crowdedDiverse.map((r) => r.sectionPath).join("|"));
  check("S5c3 무연도 문서(역대표·등번호)도 함께 도달한다",
    crowdedDiverse.some((r) => r.sectionPath === "롯데 자이언츠"),
    crowdedDiverse.map((r) => r.sectionPath).join("|"));
  check("S5c4 예약이 상한을 넘기지 않는다",
    crowdedDiverse.length === RAG_EVIDENCE_LIMIT, String(crowdedDiverse.length));
  check("S5c5 유사도 최상위는 여전히 top1 (예약은 포함만 보장, 순위 조작 아님)",
    crowdedDiverse[0].sectionPath.includes("2025년/9월"), crowdedDiverse[0].sectionPath);

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
  check("S7c searchSourcePriorityCandidates 가 currentSeason·target 을 하류로 전달",
    /rankEvidenceByQuery\(\s*deduped,\s*queryVector,\s*weightFor,\s*project,\s*currentSeason,\s*target,?\s*\)/
      .test(retrieve));
  check("S7d 시즌 가중이 랭킹 점수에 곱해진다",
    /base \* weight \* seasonWeight/.test(retrieve));

  // ══ T. 질문 시점 target — 어휘 목록 전면 제거 후 계약 (삼순 2026-08-29 5차) ═══
  //
  //   🔴 종전에는 HISTORICAL/PAST_TENSE/CURRENT 세 어휘 목록이 시점을 판정했다.
  //   `감독` 이 CURRENT 에 있어 `김성근 감독 시절` 이 새고, 막으려 PAST_TENSE 를 넣으니
  //   `현재 한화 감독 경질 가능성?` 이 반대로 샜다 — 반례마다 목록이 느는 룰 핑퐁이다.
  //   이제 판정은 **4자리 연도 존재** 하나뿐이고, 시점 해석은 근거 시점 주석 + LLM 이 한다.
  const targetCases: ReadonlyArray<[string, string, number | undefined]> = [
    // 명시 연도 — 문자 존재라 반대가설이 없는 유일한 닫힌 집합.
    ["2018년 한화 어땠어?", "year", 2018],
    ["2027 한화 전망 알려줘", "year", 2027],
    // 🔴 삼순이 준 양방향 반례 — 어휘 목록이 없으므로 둘 다 개입하지 않는다.
    ["김성근 감독이 맡았던 한화", "none", undefined],
    ["현재 한화 감독 경질 가능성?", "none", undefined],
    // 종전에 어휘로 갈리던 것들 — 전부 none 이다(룰이 시제를 맞히지 않는다).
    ["한화 역대 감독 알려줘", "none", undefined],
    ["롯데 통산 우승 횟수", "none", undefined],
    ["한화 감독 누구여", "none", undefined],
    ["롯데 요즘 어때?", "none", undefined],
    ["롯데 가을야구 갈 수 있을까?", "none", undefined],
    ["한화 대표 응원가 불러줘", "none", undefined],
    // 복수 연도는 하나로 못 좁힌다 → 개입 없음.
    ["2018년과 2019년 한화 비교해줘", "none", undefined],
  ];
  for (const [question, kind, year] of targetCases) {
    const target = resolveSeasonTarget(question, CURRENT_SEASON);
    const ok = target.kind === kind
      && (year === undefined || (target.kind === "year" && target.year === year));
    check(`T1 target — ${question} → ${kind}${year ? `(${year})` : ""}`, ok,
      JSON.stringify(target));
  }

  // 🔴 T1z 어휘 목록이 **소스에 존재하지 않는다**. 반례를 추가할 자리가 없어야 계약이다.
  //   (문면이 아니라 구조로 막는다 — 목록이 살아 있으면 언제든 되살아난다.)
  check("T1z 시점 어휘 목록이 소스에서 제거됐다",
    !/PAST_TENSE_SCOPE_WORDS|HISTORICAL_SCOPE_WORDS|CURRENT_SCOPE_WORDS/.test(retrieve));
  check("T1y SeasonTarget 은 year|none 두 갈래뿐",
    !/kind:\s*"current"|kind:\s*"historical"/.test(retrieve));

  // 가중 계약 — none 은 전 시즌 중립, year 만 개입.
  check("T2 none 은 전 시즌 중립 (개입 0)",
    seasonTargetWeight(CURRENT_SEASON, { kind: "none" }, CURRENT_SEASON) === 1
    && seasonTargetWeight(1999, { kind: "none" }, CURRENT_SEASON) === 1
    && seasonTargetWeight(null, { kind: "none" }, CURRENT_SEASON) === 1);
  check("T2b 명시 연도는 그 해가 boost, 올해는 아님",
    seasonTargetWeight(2018, { kind: "year", year: 2018 }, CURRENT_SEASON)
      === SEASON_RECENCY_CURRENT_BOOST
    && seasonTargetWeight(CURRENT_SEASON, { kind: "year", year: 2018 }, CURRENT_SEASON) < 1);

  // 종단: `2018년 한화` 질문에서 2018 문서가 실제로 올라오는가(유사도는 올해가 근소 우위).
  const y2018 = rankEvidenceByQuery(
    [evidence("한화 이글스/2026년", 0.82), evidence("한화 이글스/2018년", 0.80)],
    QUERY, undefined, undefined, CURRENT_SEASON, { kind: "year", year: 2018 },
  );
  check("T3 명시 연도 종단 — 2018 문서가 top1", y2018[0].sectionPath.includes("2018년"),
    y2018[0].sectionPath);
  // 🔴 무연도 질문 종단 — 올해로 쏠리지 않는다(순수 유사도 유지).
  const noneRanked = rankEvidenceByQuery(
    [evidence("한화 이글스", 0.80), evidence("한화 이글스/2026년", 0.79)],
    QUERY, undefined, undefined, CURRENT_SEASON, { kind: "none" },
  );
  check("T3b 무연도 종단 — 순수 유사도 순서 유지(올해 boost 없음)",
    noneRanked[0].sectionPath === "한화 이글스", noneRanked[0].sectionPath);
  // 반대 방향도 고정: 유사도가 올해 쪽이면 올해가 이긴다(가중이 아니라 유사도가 정한다).
  const noneRanked2 = rankEvidenceByQuery(
    [evidence("한화 이글스", 0.79), evidence("한화 이글스/2026년", 0.80)],
    QUERY, undefined, undefined, CURRENT_SEASON, { kind: "none" },
  );
  check("T3c 무연도 종단 — 유사도가 뒤집히면 결과도 뒤집힌다(가중 개입 0 증명)",
    noneRanked2[0].sectionPath === "한화 이글스/2026년", noneRanked2[0].sectionPath);

  // ══ L. 시즌 lane (삼순 2026-08-28 P0-①) ══════════════════════════════════
  //   🔴 RPC 가 순수 코사인 상위 40 을 먼저 자른 뒤 앱이 가중한다. 목표 시즌 청크가
  //   41위 밖이면 앱에서 아무리 가중해도 복구 불가다 — lane 은 **DB 절단 전**이어야 한다.
  //
  //   🔴 lane 은 **항상 3개**다 (삼순 2026-08-29 5차 NO-GO 반영).
  //   종전에는 target 에 따라 1개(any) 또는 3개로 갈려서, 시점 판정이 틀리면 대가가
  //   "가중치가 흔들린다"가 아니라 **목표 시즌 근거가 절단 전에 사라진다**(recall 소실)
  //   였다. 이제 후보 집합은 target 과 무관하게 같고 순위 가중만 달라진다.
  const planNone = seasonLanePlan({ kind: "none" }, CURRENT_SEASON);
  check("L1 none lane 계획 — year(올해)/yearless/any 3 lane",
    planNone.length === 3
    && planNone[0].mode === "year" && planNone[0].year === CURRENT_SEASON
    && planNone.some((l) => l.mode === "yearless")
    && planNone.some((l) => l.mode === "any"),
    JSON.stringify(planNone));
  const planYear = seasonLanePlan({ kind: "year", year: 2018 }, CURRENT_SEASON);
  check("L1b 명시 연도 lane 은 그 해로", planYear[0].mode === "year" && planYear[0].year === 2018,
    JSON.stringify(planYear));
  // 🔴 L1c 비대칭 금지 — 어떤 target 이든 lane 집합 크기가 같아야 한다.
  //   이게 깨지면 시점 오분류가 다시 recall 을 좌우한다(삼순 5차 지적의 핵심).
  check("L1c lane 개수는 target 과 무관하게 3개 (recall 비대칭 금지)",
    seasonLanePlan({ kind: "none" }, CURRENT_SEASON).length === 3
    && seasonLanePlan({ kind: "year", year: 2018 }, CURRENT_SEASON).length === 3
    && seasonLanePlan({ kind: "year", year: CURRENT_SEASON }, CURRENT_SEASON).length === 3);
  check("L1c2 lane mode 집합도 동일 (year 값만 다르다)",
    JSON.stringify(planNone.map((l) => l.mode)) === JSON.stringify(planYear.map((l) => l.mode)),
    `${JSON.stringify(planNone.map((l) => l.mode))} vs ${JSON.stringify(planYear.map((l) => l.mode))}`);
  check("L1d general(any) lane 을 항상 함께 둔다 — 목표 연도에 답이 없어도 답이 나온다",
    planNone.some((l) => l.mode === "any") && planYear.some((l) => l.mode === "any"));

  // 종단: lane 이 **DB 호출 인자로** 나가고, 절단 밖 목표 시즌 청크가 복구되는가.
  const laneCalls: Array<{ mode?: SeasonLaneMode; year?: number }> = [];
  const CAP = 2; // DB 절단을 작게 흉내낸다 — 목표 시즌 문서가 순수 코사인 밖에 있다.
  // 🔴 무대 설계 — mutation 이 결함이 되려면 픽스처가 경계를 실제로 걸쳐야 한다(M90).
  //   ① `2026년/9월` 은 any lane 절단(상위 2) **밖**이라 lane 없이는 영영 못 본다 → L2b
  //   ② `2026년/8월` 은 any lane 안에도 있고 year lane 에도 있다 → **중복** 발생 → L2c
  const corpus: Array<RagEvidenceCandidate> = [
    evidence("롯데 자이언츠/2026년/8월", 0.90),  // any lane 1위 + year lane
    evidence("롯데 자이언츠/2019년", 0.89),      // any lane 2위
    evidence("롯데 자이언츠/2020년", 0.88),
    evidence("롯데 자이언츠/2026년/9월", 0.70),  // 목표 시즌인데 any lane 절단 밖
  ];
  const laneFetch = async (
    _sourceKind: "wikipedia_document" | "namu_document",
    _limit: number,
    _vector: number[],
    lane?: { mode: SeasonLaneMode; year?: number },
  ): Promise<RagEvidenceCandidate[]> => {
    laneCalls.push({ mode: lane?.mode, year: lane?.year });
    if (_sourceKind === "wikipedia_document") return [];
    const pool = lane?.mode === "year"
      ? corpus.filter((row) => (row.sectionPath ?? "").includes(String(lane.year)))
      : lane?.mode === "yearless"
        ? corpus.filter((row) => !/(19|20)\d{2}/.test(row.sectionPath ?? ""))
        : corpus;
    // DB 는 순수 코사인 상위 N 만 돌려준다.
    return pool.slice(0, CAP);
  };
  const laneRanked = await searchSourcePriorityCandidates(
    laneFetch, QUERY, () => 1, undefined, CURRENT_SEASON, { kind: "none" },
  );
  check("L2 lane 이 DB 인자로 나간다 (year/yearless/any)",
    laneCalls.some((c) => c.mode === "year" && c.year === CURRENT_SEASON)
    && laneCalls.some((c) => c.mode === "yearless")
    && laneCalls.some((c) => c.mode === "any"),
    JSON.stringify(laneCalls));
  check("L2b 절단 밖 목표 시즌 문서가 복구된다",
    laneRanked.some((row) => (row.sectionPath ?? "").includes("2026년/9월")),
    laneRanked.map((r) => r.sectionPath).join("|"));
  check("L2c lane 중복이 제거된다 (같은 chunk 가 두 번 안 실린다)",
    new Set(laneRanked.map((r) => `${r.canonicalUrl}\u0000${r.sectionPath}`)).size
      === laneRanked.length,
    laneRanked.map((r) => r.sectionPath).join("|"));

  // 🔴 L2d 후보 집합 대칭 — target 이 달라도 **같은 lane 을 조회**한다(삼순 5차 핵심).
  //   종전에는 target 에 따라 lane 이 1개로 줄어 시점 오분류가 recall 을 죽였다.
  //   이제 판정이 틀려도 조회되는 lane 집합은 동일하고 순위 가중만 달라진다.
  const modesFor = async (target: SeasonTarget): Promise<string[]> => {
    const seen: string[] = [];
    await searchSourcePriorityCandidates(
      async (sourceKind, _l, _v, lane) => {
        if (sourceKind === "namu_document") seen.push(`${lane?.mode}:${lane?.year ?? "-"}`);
        return sourceKind === "namu_document" ? [evidence("롯데 자이언츠", 0.5)] : [];
      },
      QUERY, () => 1, undefined, CURRENT_SEASON, target,
    );
    return seen;
  };
  const modesNone = await modesFor({ kind: "none" });
  const modesYear = await modesFor({ kind: "year", year: 2018 });
  check("L2d lane mode 집합이 target 과 무관하게 동일 (recall 비대칭 금지)",
    JSON.stringify(modesNone.map((m) => m.split(":")[0]))
      === JSON.stringify(modesYear.map((m) => m.split(":")[0]))
    && modesNone.length === 3,
    `${JSON.stringify(modesNone)} vs ${JSON.stringify(modesYear)}`);
  check("L2e year lane 의 연도만 target 을 따른다",
    modesNone[0] === `year:${CURRENT_SEASON}` && modesYear[0] === "year:2018",
    `${modesNone[0]} / ${modesYear[0]}`);

  // ══ W. 배선 — 구단 경로에만 시즌 축을 켠다 ═══════════════════════════════
  check("W1 시즌 축은 team 경로 한정",
    /const seasonAware = candidate\.entityType === "team";/.test(server));
  check("W1b seasonAware 가 실제로 전달된다",
    /seasonAware \? currentSeason : undefined,\s*\n\s*seasonTarget,/.test(server));
  check("W1c lane 이 RPC 인자로 나간다",
    /p_season_mode: lane\.mode/.test(server) && /p_season_year: lane\.year/.test(server));

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

main().catch((error) => {
  console.error("FAIL 게이트 실행 실패", error);
  process.exit(1);
});
