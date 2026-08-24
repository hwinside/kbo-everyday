/**
 * 야잘알봇 캐릭터 SSOT — Notion rev1 (2026-08-06).
 *
 * Notion page: 3b4c901b-b372-81b2-af52-e4ab2d89f492
 * 이 파일에는 승인된 구조만 둔다. 미승인 팀 반응 카피 30종은 포함하지 않는다.
 */
export const BASEBALL_GENIUS_TONE_SSOT = {
  pageId: "3b4c901b-b372-81b2-af52-e4ab2d89f492",
  revision: "rev1",
  approvedAt: "2026-08-06",
} as const;

export const BASEBALL_GENIUS_TONE_PROMPT = [
  "너의 제품명과 캐릭터명은 야잘알봇이다. 별도 캐릭터명을 만들지 않는다.",
  "정중하지만 야구에 미쳐 있는 해설위원처럼 말한다.",
  "모든 답변은 합니다체로 쓴다. 해요체(~이에요, ~예요, ~네요, ~해요)는 쓰지 않는다.",
  "정중함, 야구 과몰입, 팀 중립, 사람에 대한 선의를 최상위 원칙으로 지킨다.",
  "유저, 선수, 구단, 라이벌을 비웃거나 불쌍히 여기거나 평가절하하지 않는다.",
  "부진과 패배는 사실대로 담백하게 설명하고, 근거 없는 희망이나 승리를 단정하지 않는다.",
  "고함, 명령조, 상시 구호를 쓰지 않는다. 야구에 대한 사랑과 호기심으로 흥분을 표현한다.",
  "지식 답변에는 이모지를 쓰지 않는다.",
  "승인된 언어 시그니처 '승리를 위하여!'는 smalltalk 종료에만 쓰고, 최근 positive ending 5회 안에 이미 썼다면 반복하지 않는다.",
  "유저의 지적이 자료로 확인되면 첫 문장을 '지적 감사합니다. 제가 실책했습니다. 정확히 다시 확인하겠습니다.'로 쓴다.",
  "오류를 인정할 때 야구 비유로 변명하거나 자기변호하지 않는다.",
].join("\n");

/**
 * 답변 **깊이** 계약 SSOT (2026-08-16 하린아빠: "전반적인 답변이 너무 짧게 즉답형인데
 * RAG 내에서 가능한 한 많은 정보를 풍부하게").
 *
 * 왜 상수 하나로 묶는가 — 종전에는 같은 취지의 문장이 선수·구단·뉴스·generic 프롬프트
 * **4곳에 복제**돼 있었고, 게이트와 mutation 앵커도 그 복제 문자열을 각각 잡고 있었다.
 * 한쪽만 고치면 나머지가 조용히 어긋난다(2026-08-15 앵커 복제 교훈). 문구는 여기서만
 * 바꾸고, 각 프롬프트는 이 블록을 그대로 끼워 넣는다.
 *
 * ⚠️ 이 지시는 **길이 목표**만 정한다. "근거 없는 내용 금지"는 여기 문장이 아니라
 * 출력 가드(`numericTokensGrounded`·`validateRagResponse`·상한)가 기계로 강제한다.
 * 마지막 줄은 그 계약을 모델에게 미리 알려 헛수고를 줄이는 역할이지 방어선이 아니다.
 */
export const BASEBALL_GENIUS_DEPTH_PROMPT = [
  "답변은 질문이 요구하는 만큼 충분히 설명한다. 한 줄로 끊어 즉답만 던지지 않는다.",
  "단순 사실 확인이라도 두세 문장으로 답하고, 이유·배경·사연·과정·의미를 묻는 질문은 네다섯 문장으로 풍부하게 설명한다.",
  "근거 안에 답과 이어지는 내용이 여러 갈래면 하나만 고르지 말고 함께 엮어 설명한다.",
  "다만 확인되지 않은 내용을 지어내 길이를 채우지 않는다 — 길이는 근거가 허락하는 만큼만 늘린다.",
  // 🔴 2026-08-16 실측으로 추가한 줄. 이 줄 없이 상한만 올렸더니 tier2(숫자 금지) 경로에서
  //    **폐기율이 0/10 → 3/10 으로 올랐다**. 길이를 늘리라는 지시가 모델을 더 많은 소재로
  //    밀어내고, 그 소재에 숫자가 섞이는 순간 출력 가드가 답 전체를 버린다.
  //    즉 "길게 쓰라"와 "숫자 쓰지 마라"가 충돌할 때 모델이 길이를 택하고 있었다.
  //    우선순위를 명시해 충돌을 없앤다 — 금지가 항상 이긴다.
  "길이를 늘리는 것보다 위에 적힌 금지 사항을 지키는 것이 항상 우선이다.",
  "금지된 내용(예: 숫자 사용이 금지된 경우의 수치)을 넣어야만 길어진다면, 그 부분은 통째로 빼고 허용된 내용만으로 쓴다.",
].join("\n");

/** 생성 답변은 strict, 코드가 만든 목록형 답변만 structured 면제를 명시적으로 사용한다. */
export type ToneValidationMode = "strict" | "structured";
const FORMAL_SENTENCE_ENDING_RE = /(?:니다|니까)$/u;
const HANGUL_RE = /[가-힣]/u;

function splitSentences(line: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const decimalPoint = char === "." && /\d/u.test(line[index - 1] ?? "") && /\d/u.test(line[index + 1] ?? "");
    if (!decimalPoint && (char === "." || char === "!" || char === "?" || char === "…")) {
      parts.push(line.slice(start, index + 1));
      start = index + 1;
    }
  }
  if (start < line.length) parts.push(line.slice(start));
  return parts;
}

export function isBaseballGeniusToneCompliant(
  answer: string,
  options: { mode?: ToneValidationMode } = {},
): boolean {
  const mode = options.mode ?? "strict";
  // 유저 예시·출처·목록 면제는 코드가 만든 정적 structured 출력에서만 허용한다.
  const botSpeech = mode === "structured"
    ? answer.replace(/예:\s*(?:(?:["“'‘][^"”'’]*["”'’])\s*)+/gu, "")
    : answer;
  const lines = botSpeech.split(/\n/u);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const trimmedLine = lines[lineIndex].trim();
    if (!trimmedLine) continue;
    if (mode === "structured" && /^(?:📄\s*)?출처[:：]|^https?:\/\//u.test(trimmedLine)) continue;
    for (const rawSentence of splitSentences(trimmedLine)) {
      const sentence = rawSentence
        .trim()
        .replace(/^[-*•]\s*/u, "")
        .replace(/[.!?…\s]+$/u, "")
        .replace(/[:：]$/u, "")
        .trim()
        .replace(/\s*\([^()]*\)$/u, "")
        .replace(/["”'’\])}]+$/u, "")
        .trim()
        .replace(/^["“'‘]+|["”'’]+$/gu, "")
        .trim();
      if (!sentence || !HANGUL_RE.test(sentence)) continue;
      if (FORMAL_SENTENCE_ENDING_RE.test(sentence)) continue;
      const isStructuredListFragment =
        mode === "structured" && lines.length > 1 && lineIndex > 0 && !/[.!?…]$/u.test(rawSentence.trim());
      if (isStructuredListFragment) continue;
      return false;
    }
  }
  return true;
}

/**
 * 해요체 → 합니다체 **닫힌집합** 정규화 (2026-08-24 A′).
 *
 * ## 왜 만드는가
 * 48h 로그 A0 shadow replay 실측: LLM 이 답을 낸 213런 중 135런을 게이트가 버렸고
 * 그 중 **128런(94.8%)이 톤 하나** 때문이었다. 내용은 맞는데 `~예요` 로 끝나서 죽었다.
 * 프롬프트에 이미 "해요체를 쓰지 않는다" 가 명시돼 있는데도 그렇다 — 지시로는 안 닫힌다.
 *
 * ## 왜 닫힌집합만 하는가 (⚠️ 이 모듈의 핵심 계약)
 * 위반 373문장을 어미별로 가르면 경계가 선명하다.
 *   - **닫힘 323문장(86.6%)**: 계사(이다)·하다·되다·있다/없다. 어간이 **변하지 않는다**.
 *   - **열림  50문장(13.4%)**: 일반 용언 활용(`만들어져요`·`흥미로워요`·`나뉘어요`).
 *     ㅂ/ㅅ/르 불규칙이라 어간을 **복원**해야 하고, 그건 룰로 닫히지 않는다.
 *
 * 🔴 실제로 당했다: 초안에서 `이에요 → 입니다` 를 `아니에요` 보다 **먼저** 뒀더니
 *    `아니에요 → 아니입니다` 비문이 나왔다. 그런데 내가 짠 오변환 검사기는
 *    "`니다` 로 끝나는가" 만 보고 **0건**이라 통과시켰다(육안으로 잡았다).
 *    → 검사기를 늘리는 게 아니라 **변환 자체를 어간 불변으로 좁히는 것**이 답이다.
 *    열린 활용은 여기서 손대지 않고 ②재생성으로 넘긴다
 *    (`open_language_never_closes_with_rules`).
 *
 * ## 받침 가드가 곧 한국어 규칙이다
 * `이에요` 는 받침 있는 체언 뒤, `예요` 는 받침 없는 체언 뒤에만 붙는다. 이 조건을
 * 그대로 가드로 쓰면 `아이에요`(체언이 `아이`) 를 `아`+`입니다` 로 쪼개는 사고가
 * **원리적으로** 일어나지 않는다. 조건을 못 만족하면 변환하지 않고 남긴다 —
 * 남은 문장은 게이트가 그대로 잡는다.
 *
 * ## fail-close
 * 정규화 결과는 **다시 `isBaseballGeniusToneCompliant` 를 통과해야만** 쓴다.
 * 통과 못 하면 `compliant:false` 로 알리고, 호출측은 원문을 그대로 폐기 경로에 둔다.
 * 즉 이 모듈은 **살릴 수 있는 답만 살리고, 못 살리면 아무것도 바꾸지 않는다**.
 */
function hasBatchim(char: string | undefined): boolean | null {
  if (!char) return null;
  const code = char.codePointAt(0);
  if (code === undefined || code < 0xac00 || code > 0xd7a3) return null;
  return (code - 0xac00) % 28 !== 0;
}

interface ClosedToneRule {
  /** 문장 말미(장식 제거 후)에서만 매칭한다. */
  readonly ending: string;
  readonly replacement: string;
  /**
   * 어미 **앞 글자**의 받침 조건. `null` 이면 조건 없음.
   * 조건을 못 만족하면 **변환하지 않는다** — 오변환보다 미변환이 안전하다.
   */
  readonly requireBatchim: boolean | null;
}

/**
 * ⚠️ 순서가 계약이다. 더 길고 구체적인 어미가 먼저 와야 한다.
 *   `아니에요` 가 `이에요` 뒤에 있으면 `아니입니다` 비문이 나온다(위 주석 사고).
 *   받침 가드만으로도 막히지만, 순서로 한 번 더 막아 둔다.
 *
 * ⚠️ 여기에 **일반 용언 어미(`-어요`·`-아요`·bare `-지요`)를 추가하지 마라.**
 *   `나오지요 → 나오입니다`, `흥미로워요 → 흥미로우ㅂ니다` 처럼 어간 복원이 필요해
 *   룰로 닫히지 않는다. 커버리지를 늘리고 싶으면 재생성(②)으로 간다.
 */
const CLOSED_TONE_RULES: readonly ClosedToneRule[] = [
  // ① 계사 부정 — 반드시 최상단. `아니예요` 는 흔한 오표기라 함께 받는다.
  { ending: "아니에요", replacement: "아닙니다", requireBatchim: null },
  { ending: "아니예요", replacement: "아닙니다", requireBatchim: null },
  { ending: "아녜요", replacement: "아닙니다", requireBatchim: null },
  // ② 계사 — 받침 규칙이 곧 체언 경계 보증이다.
  { ending: "이에요", replacement: "입니다", requireBatchim: true },
  { ending: "이예요", replacement: "입니다", requireBatchim: true },
  { ending: "예요", replacement: "입니다", requireBatchim: false },
  { ending: "이지요", replacement: "입니다", requireBatchim: true },
  { ending: "이죠", replacement: "입니다", requireBatchim: true },
  // ③ 되다 — `되어요`가 `돼요`보다 길므로 먼저.
  { ending: "되어요", replacement: "됩니다", requireBatchim: null },
  { ending: "되지요", replacement: "됩니다", requireBatchim: null },
  { ending: "되죠", replacement: "됩니다", requireBatchim: null },
  { ending: "돼요", replacement: "됩니다", requireBatchim: null },
  // ④ 하다.
  { ending: "하지요", replacement: "합니다", requireBatchim: null },
  { ending: "하죠", replacement: "합니다", requireBatchim: null },
  { ending: "해요", replacement: "합니다", requireBatchim: null },
  // ⑤ 있다/없다 — 어간이 그대로 남는 유일한 일반 용언쌍이라 닫힌집합에 든다.
  { ending: "있어요", replacement: "있습니다", requireBatchim: null },
  { ending: "있지요", replacement: "있습니다", requireBatchim: null },
  { ending: "있죠", replacement: "있습니다", requireBatchim: null },
  { ending: "없어요", replacement: "없습니다", requireBatchim: null },
  { ending: "없지요", replacement: "없습니다", requireBatchim: null },
  { ending: "없죠", replacement: "없습니다", requireBatchim: null },
];

/** 문장 끝 장식(문장부호·따옴표·괄호닫기)만 떼어낸다. 본문은 건드리지 않는다. */
const TRAILING_DECORATION_RE = /[.!?…\s"'’”)\]}]*$/u;

export interface FormalToneNormalization {
  /** 정규화된 답변. 바꿀 게 없었으면 입력과 동일하다. */
  readonly answer: string;
  /** 정규화 결과가 톤 SSOT 를 통과하는가. **이게 false 면 쓰면 안 된다.** */
  readonly compliant: boolean;
  /** 실제로 바꾼 문장 수 (관측용). */
  readonly converted: number;
}

/**
 * 닫힌집합 어미만 합니다체로 바꾼다. 어간은 절대 건드리지 않는다.
 *
 * 반환값의 `compliant` 가 true 일 때만 `answer` 를 채택할 것 — 이 함수는 판정하지 않고
 * **정규화 시도 결과와 그 결과의 SSOT 통과 여부**를 함께 돌려줄 뿐이다.
 */
export function normalizeToFormalTone(
  answer: string,
  options: { mode?: ToneValidationMode } = {},
): FormalToneNormalization {
  let converted = 0;
  const normalized = answer
    .split(/\n/u)
    .map((line) =>
      splitSentences(line)
        .map((rawSentence) => {
          const decoration = TRAILING_DECORATION_RE.exec(rawSentence);
          const cut = decoration ? decoration.index : rawSentence.length;
          const core = rawSentence.slice(0, cut);
          const tail = rawSentence.slice(cut);
          if (!core || !HANGUL_RE.test(core)) return rawSentence;
          // 이미 합니다체면 손대지 않는다.
          if (FORMAL_SENTENCE_ENDING_RE.test(core)) return rawSentence;
          for (const rule of CLOSED_TONE_RULES) {
            if (!core.endsWith(rule.ending)) continue;
            const stem = core.slice(0, core.length - rule.ending.length);
            // 어간이 비면 `예요` 단독 같은 조각이다 — 문장이 아니므로 두고 본다.
            if (!stem) return rawSentence;
            if (rule.requireBatchim !== null) {
              const batchim = hasBatchim(stem[stem.length - 1]);
              // 받침을 판정할 수 없거나(영문·숫자) 조건과 다르면 **변환하지 않는다**.
              if (batchim === null || batchim !== rule.requireBatchim) return rawSentence;
            }
            converted += 1;
            return `${stem}${rule.replacement}${tail}`;
          }
          return rawSentence;
        })
        .join(""),
    )
    .join("\n");
  return {
    answer: normalized,
    compliant: isBaseballGeniusToneCompliant(normalized, options),
    converted,
  };
}

export const BASEBALL_GENIUS_SIGNATURE = "승리를 위하여!";
export function appendSparsePositiveSignature(answer: string, recentPositiveAnswers: string[]): string {
  const usedRecently = recentPositiveAnswers.slice(0, 5).some((recent) => recent.includes(BASEBALL_GENIUS_SIGNATURE));
  return usedRecently ? answer : `${answer}\n${BASEBALL_GENIUS_SIGNATURE}`;
}
