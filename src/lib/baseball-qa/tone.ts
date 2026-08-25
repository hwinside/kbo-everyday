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
/** 합쇼체 의문형은 `니다` 가 아니라 `니까` 만 허용한다 (2026-08-25 삼순 P0). */
const FORMAL_INTERROGATIVE_ENDING_RE = /니까$/u;
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
      // 🔴 의문문은 `니까` 만 합쇼체다 (2026-08-25 삼순 P0). 종전엔 장식(`?`)을 떼고
      //    `니다|니까` 를 보았기 때문에 `가능합니다?` 같은 **비문을 통과**시켰다.
      //    장식을 지우기 전 원문으로 mood 를 보고, 의문이면 더 좁은 규칙을 적용한다.
      if (isInterrogativeSentence(rawSentence)) {
        if (FORMAL_INTERROGATIVE_ENDING_RE.test(sentence)) continue;
        return false;
      }
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
 * 해요체 → 합니다체 **명시적 유한 어절 매핑** (2026-08-24 A′).
 *
 * 48h A0 actual 에서 tone 위반 373문장을 전수 분해해, 사람이 검토한 106개
 * `마지막 어절 전체 → 합니다체 어절 전체` 쌍만 등록한다. suffix 규칙이 아니다.
 *
 * 🔴 폐기한 초안과 반례:
 * - `예요 → 입니다` 일반 suffix는 `거예요 → 거입니다`, `뭐예요 → 뭐입니다`를 만들고
 *   기존 validator도 `니다`만 보므로 비문을 통과시킨다.
 * - `이에요` 순서 버그는 `아니에요 → 아니입니다`를 만들었다.
 * - 받침 가드도 문법 전체를 증명하지 못한다. 따라서 **등록된 완전 어절만** 바꾼다.
 *
 * 미등록형은 byte-identical로 남고 기존 tone validator가 폐기한다. 매핑은 문장 마지막
 * 어절만 교체하므로 그 앞 본문·숫자·고유명사·출처는 byte-identical이다.
 * 실제 373문장 원장(`fixtures/genius-tone-a0-373.json`)에서 323 mapped / 50 unchanged를
 * 고정하며, `거/뭐/왜예요`와 매핑 삭제·오염 mutation은 게이트가 RED를 내야 한다.
 */
const FORMAL_TONE_WORD_MAP = new Map<string, string>([
  ["가능해요", "가능합니다"],
  ["개념이에요", "개념입니다"],
  ["개념이지요", "개념입니다"],
  ["결과예요", "결과입니다"],
  ["결정돼요", "결정됩니다"],
  ["결정전이에요", "결정전입니다"],
  ["경우예요", "경우입니다"],
  ["공식이에요", "공식입니다"],
  ["공이에요", "공입니다"],
  ["과정이에요", "과정입니다"],
  ["구종이에요", "구종입니다"],
  ["구종이지요", "구종입니다"],
  ["규정이에요", "규정입니다"],
  ["규칙이에요", "규칙입니다"],
  ["규칙이지요", "규칙입니다"],
  ["기록돼요", "기록됩니다"],
  ["기록이에요", "기록입니다"],
  ["기준이에요", "기준입니다"],
  ["까다로워해요", "까다로워합니다"],
  ["단어예요", "단어입니다"],
  ["담당해요", "담당합니다"],
  ["대기록이에요", "대기록입니다"],
  ["대지결이에요", "대지결입니다"],
  ["돼요", "됩니다"],
  ["되어요", "됩니다"],
  ["등판해요", "등판합니다"],
  ["때문이에요", "때문입니다"],
  ["뜻해요", "뜻합니다"],
  ["룰이에요", "룰입니다"],
  ["말이에요", "말입니다"],
  ["말해요", "말합니다"],
  ["매력이에요", "매력입니다"],
  ["매력이지요", "매력입니다"],
  ["명장면이에요", "명장면입니다"],
  ["명칭이에요", "명칭입니다"],
  ["모습이지요", "모습입니다"],
  ["무대예요", "무대입니다"],
  ["발생해요", "발생합니다"],
  ["발표해요", "발표합니다"],
  ["발휘해요", "발휘합니다"],
  ["방식이에요", "방식입니다"],
  ["변화구예요", "변화구입니다"],
  ["별칭이에요", "별칭입니다"],
  ["뿐이에요", "뿐입니다"],
  ["상황이에요", "상황입니다"],
  ["상황이지요", "상황입니다"],
  ["선언돼요", "선언됩니다"],
  ["선언되어요", "선언됩니다"],
  ["선언되지요", "선언됩니다"],
  ["선언해요", "선언합니다"],
  ["선정돼요", "선정됩니다"],
  ["선정해요", "선정합니다"],
  ["성립해요", "성립합니다"],
  ["수단이에요", "수단입니다"],
  ["순간이에요", "순간입니다"],
  ["순간이지요", "순간입니다"],
  ["승리해요", "승리합니다"],
  ["시작돼요", "시작됩니다"],
  ["아니에요", "아닙니다"],
  ["아웃되어요", "아웃됩니다"],
  ["아웃이에요", "아웃입니다"],
  ["약속이에요", "약속입니다"],
  ["완성돼요", "완성됩니다"],
  ["요소예요", "요소입니다"],
  ["용어예요", "용어입니다"],
  ["운영해요", "운영합니다"],
  ["원리예요", "원리입니다"],
  ["은어예요", "은어입니다"],
  ["의미해요", "의미합니다"],
  ["있어요", "있습니다"],
  ["자산이에요", "자산입니다"],
  ["작동해요", "작동합니다"],
  ["장면이에요", "장면입니다"],
  ["장면이지요", "장면입니다"],
  ["장비예요", "장비입니다"],
  ["장이에요", "장입니다"],
  ["장치예요", "장치입니다"],
  ["적용돼요", "적용됩니다"],
  ["전술이에요", "전술입니다"],
  ["존재해요", "존재합니다"],
  ["종료돼요", "종료됩니다"],
  ["종류예요", "종류입니다"],
  ["종목이에요", "종목입니다"],
  ["줄임말이에요", "줄임말입니다"],
  ["즐거움이에요", "즐거움입니다"],
  ["지표예요", "지표입니다"],
  ["진기록이에요", "진기록입니다"],
  ["진행돼요", "진행됩니다"],
  ["처리되어요", "처리됩니다"],
  ["충족되어요", "충족됩니다"],
  ["칭호예요", "칭호입니다"],
  ["카운트예요", "카운트입니다"],
  ["타이틀이에요", "타이틀입니다"],
  ["투구예요", "투구입니다"],
  ["투수예요", "투수입니다"],
  ["특징이에요", "특징입니다"],
  ["판정이에요", "판정입니다"],
  ["패치예요", "패치입니다"],
  ["포지션이에요", "포지션입니다"],
  ["포지션이지요", "포지션입니다"],
  ["포함돼요", "포함됩니다"],
  ["표현이에요", "표현입니다"],
  ["필요해요", "필요합니다"],
  ["하나예요", "하나입니다"],
  ["해요", "합니다"],
  ["활용되어요", "활용됩니다"],
]);

/**
 * A′ ② 실 provider shadow 45런에서 tone+내용보존을 함께 통과한 **완전 어절쌍 19개**.
 * provider가 이 쌍 밖의 마지막 어절을 내면 prefix가 같아도 의미 동등성을 증명할 수 없으므로
 * 폐기한다. `좋아요→싫습니다` 같은 짧은 반의어가 edit-distance를 통과하는 반례 때문에
 * 유사도 규칙을 폐기하고 exact allowlist로 닫았다. 신규 쌍은 shadow+사람 검토+PR이 필요하다.
 *
 * 🔴 2026-08-24 삼순 NO-GO 로 **`보여요 → 보여줍니다` 쌍을 제거**했다. 이 쌍은 자동사
 * (`표정이 보여요` = 보인다)와 타동사(`자료를 보여요` = 보여준다)를 한 어절로 묶어
 * `선수의 긴장감이 얼굴에 보여요 → …보여줍니다` 같은 의미·문법 훼손을 보존으로 통과시킨다.
 * 어절 단위 exact key 로는 이 모호성을 닫을 수 없으므로 **쌍 자체를 fail-close** 한다
 * (모호한 쌍은 등록하지 않는다 — 잘못 서빙하느니 폐기한다).
 *
 * 🔴 2026-08-25 삼순 P0 으로 **`보여줘요` 도 제거**했다(20→19→18쌍). 지난번엔 "타동사가
 * 문면에 드러나니 비모호"라고 판단했으나 틀렸다 — `그래프가 차이를 보여줘요`(서술)와
 * `기록표를 보여줘요`(요청·명령)가 **같은 key** 라 mood 가 갈리지 않는다. 서술형
 * `보여줍니다` 로 강제하면 요청문이 서술문으로 둘갑한다. shadow 45 에서 이 쌍은
 * 1건(index 33)을 수용시켰고, 제거 후 그 1건은 폐기된다(accepted 22→21).
 */
const FORMAL_TONE_REWRITE_WORD_MAP = new Map<string, string>([
  ["겪어요", "겪습니다"],
  ["기려요", "기립니다"],
  ["깊어요", "깊습니다"],
  ["나뉘어요", "나뉩니다"],
  ["도입되었어요", "도입되었습니다"],
  ["들어서지요", "들어섭니다"],
  ["만들어져요", "만들어집니다"],
  ["많아요", "많습니다"],
  ["바뀌었어요", "바뀌었습니다"],
  ["받아요", "받습니다"],
  ["붙여졌어요", "붙여졌습니다"],
  ["생겨요", "생깁니다"],
  ["쓰여요", "쓰입니다"],
  ["않아요", "않습니다"],
  ["여겨요", "여깁니다"],
  ["유래했어요", "유래했습니다"],
  ["주어져요", "주어집니다"],
  ["했어요", "했습니다"],
]);

/** 문장 끝 장식(문장부호·따옴표·괄호닫기)만 떼어낸다. 본문은 건드리지 않는다. */
const TRAILING_DECORATION_RE = /[.!?…\s"'’”)\]}]*$/u;

/**
 * 의문문인가 — **서술형 매핑을 쓰면 안 되는 문장**을 가린다 (2026-08-25 삼순 P0).
 *
 * 🔴 `가능해요?` 가 ①에서 `가능합니다?` 로 바뀌고, validator 는 장식(`?`)을 떼고
 * `니다` 만 보므로 **비문을 통과시켰다**. 합쇼체 의문형은 `니다` 가 아니라 `니까` 이다.
 * A0 373·shadow 45 에 `?` 는 각 0건이라 이 무대는 원장이 증명해주지 않는다 —
 * mood 별 exact 쌍을 사람이 검토해 등록하기 전까지는 **건드리지 않고 폐기**한다.
 */
function isInterrogativeSentence(sentence: string): boolean {
  const decoration = TRAILING_DECORATION_RE.exec(sentence);
  const tail = decoration ? sentence.slice(decoration.index) : "";
  return tail.includes("?");
}

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
          // 🔴 의문문은 서술형 매핑의 적용 대상이 아니다 — byte-identical 로 남겨 폐기시킨다
          //    (`가능해요?` → `가능합니다?` 비문 방지, 2026-08-25 삼순 P0).
          if (isInterrogativeSentence(rawSentence)) return rawSentence;
          // 이미 합니다체면 손대지 않는다.
          if (FORMAL_SENTENCE_ENDING_RE.test(core)) return rawSentence;
          const wordStart = Math.max(
            core.lastIndexOf(" "), core.lastIndexOf("\t"), core.lastIndexOf("\u00a0"),
          ) + 1;
          const word = core.slice(wordStart);
          const replacement = FORMAL_TONE_WORD_MAP.get(word);
          if (replacement === undefined) return rawSentence;
          converted += 1;
          return `${core.slice(0, wordStart)}${replacement}${tail}`;
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


interface ToneSentenceShape {
  readonly prefix: string;
  readonly word: string;
  readonly decoration: string;
}

function toneSentenceShape(sentence: string): ToneSentenceShape {
  const decorationMatch = TRAILING_DECORATION_RE.exec(sentence);
  const cut = decorationMatch ? decorationMatch.index : sentence.length;
  const core = sentence.slice(0, cut);
  const wordStart = Math.max(
    core.lastIndexOf(" "), core.lastIndexOf("\t"), core.lastIndexOf("\u00a0"),
  ) + 1;
  return {
    prefix: core.slice(0, wordStart),
    word: core.slice(wordStart),
    decoration: sentence.slice(cut),
  };
}

function stableTokens(text: string): string[] {
  // 수치·영문 식별자·10구단명은 rewrite 마지막 어절 안에 있어도 exact multiset 보존한다.
  // 문장 마지막 어절 밖의 한국어 고유명사는 prefix byte-identical 계약이 더 강하게 보호한다.
  return text.match(/\d+(?:[.,]\d+)*|[A-Za-z][A-Za-z0-9._-]*|LG|두산|KT|SSG|NC|KIA|롯데|삼성|한화|키움/gu)
    ?.sort() ?? [];
}

/**
 * A′ ② rewrite가 **말투 외 내용을 바꾸지 않았는지** 판정한다.
 *
 * 허용 변화는 각 문장의 마지막 어절 하나뿐이다. 그 앞 prefix와 문장부호·줄/문장 개수는
 * byte-identical, 수치·영문 식별자·구단명 multiset도 exact여야 한다. 마지막 어절도
 * `요` 종결(단, ①에서 의도적으로 미등록한 copula `예요/이에요/에요` 제외) → 합니다체이며,
 * shadow에서 검토된 완전 어절쌍 20개 중 하나여야 한다. 조건 하나라도 어기면 폐기한다.
 *
 * 이 함수는 의미 동등성을 "추정"하지 않는다. 모델이 문장을 재서술할 자유를 구조적으로
 * 없애고, 관측 가능한 문자 변화 표면을 마지막 어절로 닫는다.
 */
export function isToneRewriteContentPreserving(original: string, rewritten: string): boolean {
  if (original === rewritten || !isBaseballGeniusToneCompliant(rewritten)) return false;
  if (JSON.stringify(stableTokens(original)) !== JSON.stringify(stableTokens(rewritten))) return false;
  const originalLines = original.split(/\n/u).map(splitSentences);
  const rewrittenLines = rewritten.split(/\n/u).map(splitSentences);
  if (originalLines.length !== rewrittenLines.length) return false;
  for (let line = 0; line < originalLines.length; line += 1) {
    if (originalLines[line].length !== rewrittenLines[line].length) return false;
    for (let sentence = 0; sentence < originalLines[line].length; sentence += 1) {
      const originalSentence = originalLines[line][sentence];
      const rewrittenSentence = rewrittenLines[line][sentence];
      // 이미 합니다체인 문장은 provider가 byte-identical로 보존해야 한다.
      if (originalSentence === rewrittenSentence) {
        if (!isBaseballGeniusToneCompliant(originalSentence)) return false;
        continue;
      }
      const before = toneSentenceShape(originalSentence);
      const after = toneSentenceShape(rewrittenSentence);
      if (before.prefix !== after.prefix || before.decoration !== after.decoration) return false;
      if (FORMAL_TONE_REWRITE_WORD_MAP.get(before.word) !== after.word) return false;
    }
  }
  return true;
}

export const BASEBALL_GENIUS_SIGNATURE = "승리를 위하여!";
export function appendSparsePositiveSignature(answer: string, recentPositiveAnswers: string[]): string {
  const usedRecently = recentPositiveAnswers.slice(0, 5).some((recent) => recent.includes(BASEBALL_GENIUS_SIGNATURE));
  return usedRecently ? answer : `${answer}\n${BASEBALL_GENIUS_SIGNATURE}`;
}
