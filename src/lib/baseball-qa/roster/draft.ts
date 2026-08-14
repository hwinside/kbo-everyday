/**
 * KBO 공식 선수 프로필의 **입단 정보**(`lblDraft`)를 typed 값으로 읽는다.
 *
 * ── 왜 이 파일이 있는가 (2026-08-09 하린아빠 제보) ──────────────────────────
 *
 *     유저: `임찬규는 LG에 언제 입단했어?`
 *     봇  : (연도를 못 말하고 겉도는 답)
 *
 *   선수 tier2(나무위키) 경로는 **숫자 전면 HOLD** 다. 근거 문장에 `2011년 입단` 이
 *   있어도 토큰 대조로는 같은 chunk 안 다른 연도(데뷔·이적·FA·군복무)와 구분할 수
 *   없기 때문이다 — #1110 에서 13커밋을 쌓았다가 전부 지운 자리고, 그때 확정한 원칙이
 *   "코드 가드는 반대가설을 못 만드는 것만" 이다.
 *
 * ── 그래서 문장을 파싱하지 않는다 (삼순 2026-08-09 설계 정정) ────────────────
 *
 *   KBO 공식 프로필에는 입단 정보가 **이미 구조화 필드**로 있다:
 *
 *       lblDraft = `11 LG 1라운드 2순위`   (임찬규 61101)
 *                  `22 KIA 1차`           (김도영 52605)
 *                  `05 LG 1차`            (박병호 75125 — 현재는 키움)
 *
 *   여기엔 데뷔·이적·FA 가 섞일 여지가 **구조적으로 없다**. 그 필드가 뜻하는 바가
 *   하나뿐이라 #1110 의 반대가설이 성립하지 않는다. 그래서 이건 파싱이 아니라 조회고,
 *   tier2 숫자 HOLD 를 열지 않고도 확정 사실을 말할 수 있다.
 *
 *   ⚠️ 이 값은 **RAG 근거가 아니다.** 공식 필드에서 온 typed 값이며, 렌더도 코드가 한다
 *     (LLM·RAG·cache 를 태우지 않는다). 값이 없으면 지어내지 않고 fail-close 한다.
 *
 * ── 저장 위치 (2026-08-09 배포 게이트가 잡음) ──────────────────────────────
 *   원문은 `src/lib/constants/players-draft.json` 에 둔다. roster JSON 에 얹으면
 *   ① 상시 크롤(`crawl-roster-v2`)이 고정 필드 목록으로 재조립하며 날리고
 *   ② roster 파일 해시가 corpus census 지문에 묶여 무관한 게이트를 깨뜨린다.
 */

/** KBO 공식 `lblDraft` 에서 읽어낸 입단 정보 */
export interface DraftInfo {
  /** 입단 연도 (4자리) */
  year: number;
  /** 입단 구단 표기 (공식 페이지 표기 그대로: `LG`·`KIA`·`NC` …) */
  team: string;
  /**
   * 지명 방식 원문 (`1라운드 2순위`·`1차`·`육성선수`·`자유선발` …).
   *
   * 실측 분포(846건): 라운드 표기 664 · `1차` 69 · `육성선수` 75 · `자유선발` 19.
   * 형식이 여러 가지라 **해석하지 않고 원문 그대로** 보관한다 — 우리가 재서술하면
   * 공식 표기와 달라진다.
   */
  detail: string;
}

/**
 * 두 자리 연도를 4자리로 편다.
 *
 * ⚠️ 임의의 세기 추정이 아니다. **KBO 는 1982년 출범**했으므로 입단 연도는 1982 이상이다.
 *   따라서 `82`~`99` 는 19xx, `00`~`81` 은 20xx 로 유일하게 결정된다 — 겹치는 해가 없다.
 */
function expandTwoDigitYear(yy: number): number {
  return yy >= 82 ? 1900 + yy : 2000 + yy;
}

/**
 * 미래 연도 상한. **현재 연도 + 1** 까지만 인정한다 (삼순 2026-08-09).
 *
 * ⚠️ 종전 구현은 `27`~`81` 을 2027~2081 로 그대로 받았다. 그러면 데이터 오류·오타가
 *   "2055년에 입단했어요" 같은 확정 문장으로 나간다 — 공식값이라 더 믿게 된다.
 *
 * `+1` 인 이유: 신인 드래프트는 **전년도 가을**에 열려서 이듬해 입단으로 표기된다.
 *   실측(2026-08-09): `26 한화 2라운드 13순위`(2007년생)가 이미 존재한다.
 */
function isPlausibleDraftYear(year: number, now: Date): boolean {
  return year >= 1982 && year <= now.getFullYear() + 1;
}

/**
 * `lblDraft` 원문을 파싱한다. 형식을 벗어나면 **null**(= 모름)이다.
 *
 * ⚠️ 부분 성공을 만들지 않는다. 연도만 읽히고 구단이 안 읽히면 null 이다 —
 *   반쪽 값을 돌려주면 호출부가 "있다" 로 착각하고 불완전한 문장을 내보낸다.
 *
 * 실측 형식(2026-08-09, KBO 공식):
 *   `11 LG 1라운드 2순위` · `22 KIA 1차` · `13 NC 특별 20순위` · `24 두산 육성선수`
 *   외국인·육성 일부는 **빈 문자열**로 온다 → null.
 *
 * @param now 미래 연도 판정 기준. 테스트가 시점을 고정할 수 있게 주입받는다.
 */
export function parseDraftLabel(
  raw: string | null | undefined,
  now: Date = new Date(),
): DraftInfo | null {
  const value = (raw ?? "").trim();
  if (value.length === 0) return null;
  const matched = /^(\d{2})\s+([A-Za-z가-힣]+)\s*(.*)$/.exec(value);
  if (!matched) return null;
  const yy = Number(matched[1]);
  if (!Number.isInteger(yy)) return null;
  const year = expandTwoDigitYear(yy);
  // 미래 연도는 데이터 오류다. 지어낸 확정 문장을 내보내느니 모른다고 한다.
  if (!isPlausibleDraftYear(year, now)) return null;
  // ⚠️ 구단명은 **정규식이 필수로 잡는다**(`[A-Za-z가-힣]+`). 여기서 다시 빈 문자열을
  //   검사하던 가드는 도달 불가라 삭제했다(mutation D-F 가 동등변이로 드러냈다).
  //   "부분 성공 금지"는 이 정규식이 유일한 방어축이므로, mutation 도 그 정규식을 태운다.
  return { year, team: matched[2].trim(), detail: matched[3].trim() };
}

/** 지명 순번(라운드·순위·1차 …)을 묻는 질문인가 — 연도만 답하면 동문서답이다. */
export function asksDraftDetail(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return /라운드|순위|순번|몇번째|지명방식|몇차/.test(compact);
}

/**
 * 유저에게 보여줄 한 문장. **코드가 만든다** — LLM 을 태우지 않는다.
 *
 * ⚠️ 세 가지를 지킨다(삼순 2026-08-09 P0-3):
 *   ① 공식 표기 구단명을 그대로 쓴다. 우리 앱 표기로 바꾸지 않는다 — 입단 당시 구단과
 *      현재 구단이 다를 수 있고(이적), 그때 우리 표기로 옮기면 사실이 바뀐다.
 *   ② 질문이 **다른 구단**을 지목했으면 그 사실을 밝힌다. `박병호는 키움에 언제 입단?`
 *      에 "2005년에 LG 에 입단했어요" 만 주면 유저는 키움 입단으로 읽는다.
 *   ③ 순번을 물었으면 순번을 답한다. 연도만 주면 질문에 답하지 않은 것이다.
 *
 * @param askedTeam 질문이 지목한 구단(우리 표기). 없으면 null.
 */
export function renderDraftAnswer(
  playerName: string,
  draft: DraftInfo,
  options: { askedTeam?: string | null; wantsDetail?: boolean } = {},
): string {
  const { askedTeam = null, wantsDetail = false } = options;
  const detail = draft.detail.length > 0 ? ` ${draft.detail}` : "";
  const head = wantsDetail && detail.length > 0
    ? `${playerName} 선수는 ${draft.year}년 ${draft.team}${detail}로 입단했습니다.`
    : `${playerName} 선수는 ${draft.year}년에 ${draft.team}에 입단했습니다.`;
  // 질문이 지목한 구단과 입단 구단이 다르면 **오해를 남기지 않는다**.
  // ⚠️ 단 "그 구단에 입단한 건 아니다"라고 단정하지 않는다(삼순 2026-08-09) — 공식
  //   `lblDraft` 는 **최초 지명**만 증명하고, 이후 이적으로 그 구단에 합류했을 수 있다
  //   (박병호: 2005 LG 지명 → 현재 키움). 이 필드로 증명 못 하는 범위는 그렇다고 말한다.
  if (askedTeam && !teamMatches(askedTeam, draft.team)) {
    return `${head} 다만 ${askedTeam} 합류 시점은 공식 입단(최초 지명) 기록으로는 확인할 수 없습니다.`;
  }
  return head;
}

/**
 * 우리 앱 구단 표기와 공식 `lblDraft` 구단 표기가 같은 팀인가.
 *
 * ⚠️ 표기가 완전히 같지 않다(`KIA`/`기아`, `키움`/`넥센`). 지금 필요한 것은
 *   "다른 팀인데 같다고 답하는 것"을 막는 일이므로, **모르면 다르다고 하지 않는다** —
 *   판정 불가는 `true`(=경고문 생략)가 아니라 표기 정규화 후 문자열 비교로만 가른다.
 */
function teamMatches(a: string, b: string): boolean {
  const norm = (value: string) => value.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return norm(a) === norm(b);
}

/**
 * 공식값이 없을 때의 문장. **구체적으로** 말한다(삼순 2026-08-09).
 *
 * "모르겠어요" 로 뭉개면 유저는 질문을 고쳐 다시 쓴다. 무엇이 없어서 못 답하는지를
 * 밝혀야 유저가 다음 행동을 정할 수 있다.
 *
 * ⚠️ `""`(공식이 빈값으로 준 것 = 등록 없음)과 `undefined`(우리가 아직 안 긁음)를
 *   **구분해서** 말한다. 둘 다 "공식에 없다" 고 하면, 우리 수집 누락을 KBO 탓으로
 *   돌리는 거짓 진술이 된다(삼순 2026-08-09).
 */
export function renderDraftUnavailable(
  playerName: string,
  reason: "not_registered" | "not_collected",
): string {
  return reason === "not_registered"
    ? `${playerName} 선수의 입단 정보는 KBO 공식 기록에 등록돼 있지 않아 안내할 수 없습니다.`
    : `${playerName} 선수의 입단 정보는 아직 확인하지 못했습니다. 조금 뒤에는 다시 확인할 수 있습니다.`;
}

/** 원문 보관 상태 → 안내 사유. `undefined`(미수집)와 `""`(미등록)를 가른다. */
export function draftUnavailableReason(
  raw: string | null | undefined,
): "not_registered" | "not_collected" {
  return raw === undefined || raw === null ? "not_collected" : "not_registered";
}

/**
 * 이 질문이 **입단(드래프트) 질문**인가.
 *
 * ⚠️ 좁게 잡는다. 넓히면 `데뷔`·`이적`·`FA` 같은 **다른 사건**까지 이 경로로 끌려오는데,
 *   `lblDraft` 는 그 값들을 담고 있지 않다. 없는 사실을 공식값처럼 말하는 게 최악이다.
 *   `데뷔`는 입단과 연도가 다른 선수가 흔하다 — 의도적으로 제외한다.
 *
 * ⚠️ `몇순위`·`몇라운드` **단독은 드래프트 앵커가 아니다**(삼순 2026-08-09 P0-3).
 *   `임찬규 지금 몇 순위야?` 는 현재 성적 얘기다. 순위류 표현은 `지명`·`드래프트`·`입단`
 *   앵커가 같이 있을 때만 이 경로다. `지명타자`의 `지명`은 앵커가 아니므로 제거 후 판정한다.
 */
export function isDraftQuestion(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (/입단|드래프트/.test(compact)) return true;
  // `지명타자`(포지션)의 `지명`이 드래프트 앵커로 오인되지 않게 지우고 본다.
  const withoutDh = compact.replace(/지명타자/g, "");
  return /지명/.test(withoutDh) && /라운드|순위|순번|몇번째|방식/.test(withoutDh);
}

/**
 * 이름 없는 입단 질문이 **직전 턴을 되묻는 문법**인가 (삼순 2026-08-09 후속 과결속 차단).
 *
 * ⚠️ "이름을 못 풀었다"는 후속의 근거가 아니다 — 이름이 아예 없는 일반 질문
 *   (`KBO 드래프트 언제야?`)과 복수·동명이인 질문까지 직전 선수로 새면 오답이 된다.
 *   그래서 **명시 되묻기 어미**(`~했냐고?`류 인용 어미) 또는 **명시 지시어**
 *   (`그 선수`·`걔`)가 있을 때만 직전 턴 결속 후보다. 둘 다 닫힌 문법 부류다.
 */
export function isDraftFollowupGrammar(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  // 되묻기 인용 어미 — 문장 끝에서만 인정한다 (중간 인용은 새 진술일 수 있다).
  if (/(냐고|다고|라고)(요)?[?!.]*$/.test(compact)) return true;
  // 명시 지시어 — 사람을 가리키는 닫힌 집합만. `그` 단독은 과탐이라 넣지 않는다.
  return /그선수|그사람|그분|걔/.test(compact);
}
