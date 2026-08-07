/**
 * 야잘알봇 **최신성 의도 판정** — 기사 근거(news_rag) 경로의 진입 조건이자 검색 창.
 *
 * 왜 별도 순수 모듈인가
 *   삼순 조건부 GO ②: "`어제`는 KST 상·하한 exact, `요즘/최근`은 고정 기간". 즉 이 판정은
 *   **검색 술어를 직접 만든다** — 틀리면 유저가 물은 날이 아닌 날의 기사로 답한다.
 *   pipeline 안에 인라인으로 두면 게이트가 종단 응답으로만 검증할 수 있어 경계값
 *   (자정 직전/직후, KST↔UTC 경계)을 직접 태울 수 없다. 순수 함수로 뽑아 게이트가
 *   `now` 를 주입해 경계를 exact 로 대조한다.
 *
 * 계약
 *   1. **`out_of_window` 는 news 가 소유하지 않는다.** `올해`·`이번 시즌`·`작년` 은
 *      30일 롤링 창 밖이라, 기사로 답하면 반드시 일부 기간만 본 답이 된다.
 *      news 를 건너뛰고 기존 경로(team_rag → generic)로 그대로 내려보낸다.
 *   2. **`fresh` 는 news 가 소유한다.** 이 판정이 나오면 기사 근거가 0건이거나 검색이
 *      실패해도 team_rag/generic 으로 폴백하지 않는다(삼순 ②). 폴백하면 "어제 무슨 일"에
 *      한 달 전 문서 서술이 붙어 나가는데, 그건 틀린 답을 최신인 것처럼 파는 것이다.
 *   3. **상·하한은 반열린 구간 [since, until)** 이다. 자정에 걸친 기사가 두 날에
 *      동시에 속하거나 어느 날에도 안 속하는 상태를 만들지 않는다.
 */

/** KST = UTC+9. 서버가 어느 TZ 로 뜨든 판정이 흔들리면 안 되므로 오프셋을 직접 계산한다. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `요즘`·`최근` 이 뜻하는 고정 기간(일).
 *
 * 왜 고정인가 (삼순 ②): 상대 표현을 그때그때 다른 창으로 해석하면 같은 질문이 날마다
 * 다른 근거를 받는다. 재현 불가능한 답은 감사도 불가능하다.
 * 보유기간(30일)보다 짧게 둔다 — `요즘` 에 29일 전 기사가 최상위로 붙으면 최신이 아니다.
 */
export const NEWS_RECENT_WINDOW_DAYS = 7;

export type NewsRecencyIntent =
  /** 최신성 신호 없음. news 경로는 진입하지 않는다(기존 경로 그대로). */
  | { kind: "none" }
  /**
   * 최신성을 물었지만 기사 보유 창(30일) 밖이다. news 가 소유하지 않는다 —
   * 폴백이 아니라 **애초에 이 경로의 질문이 아니다**.
   */
  | { kind: "out_of_window"; label: string }
  /** news 가 소유한다. [since, until) 안의 기사만 근거로 쓴다. */
  | { kind: "fresh"; label: string; since: Date; until: Date };

/**
 * 기사 창(30일) 밖을 가리키는 시간 표현.
 *
 * ⚠️ `fresh` 신호보다 **먼저** 판정한다. `올해 요즘 LG 어때?` 처럼 둘이 섞이면
 * 보수적으로 out_of_window 다 — 30일치로 `올해` 를 답하면 일부만 보고 전체를 말하는 셈이다.
 */
const OUT_OF_WINDOW_PATTERNS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /올\s?해|금년/, label: "올해" },
  { pattern: /이번\s?시즌|올\s?시즌|금\s?시즌/, label: "이번 시즌" },
  { pattern: /작년|지난\s?해|재작년/, label: "작년" },
  { pattern: /지난\s?시즌|저번\s?시즌/, label: "지난 시즌" },
  { pattern: /\d{4}\s?년/, label: "특정 연도" },
  { pattern: /지난\s?달|저번\s?달|이번\s?달/, label: "월 단위" },
];

/** 상대 날짜 표현 → KST 날짜 오프셋(오늘 = 0). */
const DAY_PATTERNS: readonly { pattern: RegExp; label: string; offset: number }[] = [
  { pattern: /그저께|그제/, label: "그저께", offset: -2 },
  { pattern: /어제|어저께/, label: "어제", offset: -1 },
  { pattern: /오늘|금일/, label: "오늘", offset: 0 },
];

/** 고정 기간(7일)으로 해석하는 표현. */
const RECENT_PATTERN = /요즘|요새|최근|근래|며칠|얼마\s?전|이번\s?주|지난\s?주|저번\s?주/;

/**
 * KST 하루의 [시작, 끝) 을 UTC 기준 Date 로 만든다.
 *
 * `nowMs + 9h` 를 하루 길이로 바닥내림하면 "KST 기준 며칠째인가" 가 나온다.
 * 여기서 오프셋을 다시 빼면 그 KST 날짜의 00:00 에 해당하는 UTC 순간이다.
 */
function kstDayBounds(nowMs: number, dayOffset: number): { since: Date; until: Date } {
  const kstDayIndex = Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) + dayOffset;
  const startUtcMs = kstDayIndex * DAY_MS - KST_OFFSET_MS;
  return { since: new Date(startUtcMs), until: new Date(startUtcMs + DAY_MS) };
}

/**
 * 질문에서 최신성 의도를 판정한다.
 *
 * @param nowMs 판정 기준 시각(ms). 게이트가 경계값을 주입한다.
 */
export function resolveNewsRecency(question: string, nowMs: number): NewsRecencyIntent {
  const normalized = question.normalize("NFKC").toLowerCase();

  for (const { pattern, label } of OUT_OF_WINDOW_PATTERNS) {
    if (pattern.test(normalized)) return { kind: "out_of_window", label };
  }

  for (const { pattern, label, offset } of DAY_PATTERNS) {
    if (!pattern.test(normalized)) continue;
    const bounds = kstDayBounds(nowMs, offset);
    // 오늘은 아직 끝나지 않았다. 상한을 자정으로 두면 "미래 기사"까지 허용하는 창이 된다.
    const until = offset === 0 ? new Date(nowMs) : bounds.until;
    return { kind: "fresh", label, since: bounds.since, until };
  }

  if (RECENT_PATTERN.test(normalized)) {
    return {
      kind: "fresh",
      label: "최근",
      since: new Date(nowMs - NEWS_RECENT_WINDOW_DAYS * DAY_MS),
      until: new Date(nowMs),
    };
  }

  return { kind: "none" };
}
