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
 *                  `13 NC 특별 20순위`
 *
 *   여기엔 데뷔·이적·FA 가 섞일 여지가 **구조적으로 없다**. 그 필드가 뜻하는 바가
 *   하나뿐이라 #1110 의 반대가설이 성립하지 않는다. 그래서 이건 파싱이 아니라 조회고,
 *   tier2 숫자 HOLD 를 열지 않고도 확정 사실을 말할 수 있다.
 *
 *   ⚠️ 이 값은 **RAG 근거가 아니다.** 공식 필드에서 온 typed 값이며, 렌더도 코드가 한다
 *     (LLM·RAG·cache 를 태우지 않는다). 값이 없으면 지어내지 않고 fail-close 한다.
 */

/** KBO 공식 `lblDraft` 에서 읽어낸 입단 정보 */
export interface DraftInfo {
  /** 입단 연도 (4자리) */
  year: number;
  /** 입단 구단 표기 (공식 페이지 표기 그대로: `LG`·`KIA`·`NC` …) */
  team: string;
}

/**
 * 두 자리 연도를 4자리로 편다.
 *
 * ⚠️ 임의의 세기 추정이 아니다. **KBO 는 1982년 출범**했으므로 입단 연도는 1982 이상이다.
 *   따라서 `82`~`99` 는 19xx, `00`~`81` 은 20xx 로 유일하게 결정된다 — 겹치는 해가 없다.
 *   (2081년까지 유효하다. 그 뒤를 걱정할 코드가 아니다.)
 */
function expandTwoDigitYear(yy: number): number {
  return yy >= 82 ? 1900 + yy : 2000 + yy;
}

/**
 * `lblDraft` 원문을 파싱한다. 형식을 벗어나면 **null**(= 모름)이다.
 *
 * ⚠️ 부분 성공을 만들지 않는다. 연도만 읽히고 구단이 안 읽히면 null 이다 —
 *   반쪽 값을 돌려주면 호출부가 "있다" 로 착각하고 불완전한 문장을 내보낸다.
 *
 * 실측 형식(2026-08-09, KBO 공식):
 *   `11 LG 1라운드 2순위` · `22 KIA 1차` · `13 NC 특별 20순위`
 *   외국인·육성선수 등은 **빈 문자열**로 온다 → null.
 */
export function parseDraftLabel(raw: string | null | undefined): DraftInfo | null {
  const value = (raw ?? "").trim();
  if (value.length === 0) return null;
  // 앞부분 `<2자리 연도> <구단>` 만 계약이다. 뒤(라운드·순위·1차·특별)는 읽지 않는다 —
  // 표기가 여러 가지고 우리가 답할 내용도 아니다.
  const matched = /^(\d{2})\s+([A-Za-z가-힣]+)/.exec(value);
  if (!matched) return null;
  const yy = Number(matched[1]);
  if (!Number.isInteger(yy)) return null;
  const year = expandTwoDigitYear(yy);
  const team = matched[2].trim();
  if (team.length === 0) return null;
  return { year, team };
}

/**
 * 유저에게 보여줄 한 문장. **코드가 만든다** — LLM 을 태우지 않는다.
 *
 * 공식 표기 구단명을 그대로 쓴다. 우리 앱 표기로 바꾸지 않는다 — 입단 당시 구단과
 * 현재 구단이 다를 수 있고(이적), 그때 우리 표기로 옮기면 사실이 바뀐다.
 */
export function renderDraftAnswer(playerName: string, draft: DraftInfo): string {
  return `${playerName} 선수는 ${draft.year}년에 ${draft.team}에 입단했어요.`;
}

/**
 * 공식값이 없을 때의 문장. **구체적으로** 말한다(삼순 2026-08-09).
 *
 * "모르겠어요" 로 뭉개면 유저는 질문을 고쳐 다시 쓴다. 무엇이 없어서 못 답하는지를
 * 밝혀야 유저가 다음 행동을 정할 수 있다.
 */
export function renderDraftUnavailable(playerName: string): string {
  return `${playerName} 선수의 입단 정보는 KBO 공식 기록에 등록돼 있지 않아 알려드릴 수 없어요.`;
}

/**
 * 이 질문이 **입단(드래프트) 질문**인가.
 *
 * ⚠️ 좁게 잡는다. 넓히면 `데뷔`·`이적`·`FA` 같은 **다른 사건**까지 이 경로로 끌려오는데,
 *   `lblDraft` 는 그 값들을 담고 있지 않다. 없는 사실을 공식값처럼 말하는 게 최악이다.
 *   `데뷔`는 입단과 연도가 다른 선수가 흔하다 — 의도적으로 제외한다.
 */
export function isDraftQuestion(question: string): boolean {
  const compact = question.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  return /입단|드래프트|지명순위|몇순위|몇라운드/.test(compact);
}
