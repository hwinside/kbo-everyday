// 야구 용어/룰 질문 정규화 (spec: specs/baseball-qa-mvp.md §2)
// 목표: "ABS가 뭐예요?" / "보크란 무엇인가요" 같은 질문을 사전 term/alias와
// exact 매칭 가능한 키("abs", "보크")로 축약한다.

// 질문형 어미/요청 표현 (정규화 후 = 공백·문장부호 제거 상태 기준)
const QUESTION_SUFFIXES = [
  "인지알려줘",
  "인지궁금해요",
  "인지궁금해",
  "무엇인가요",
  "무엇인지",
  "무엇인가",
  "무엇임",
  "무엇이야",
  "무엇이에요",
  "무엇예요",
  "뭐인가요",
  "뭐예요",
  "뭐에요",
  "뭐야",
  "뭐임",
  "뭐지",
  "뭐죠",
  "뭔가요",
  "뭔데",
  "뭔지",
  "무슨뜻인가요",
  "무슨뜻이에요",
  "무슨뜻이야",
  "무슨뜻이죠",
  "무슨뜻",
  "무슨말인가요",
  "무슨말이야",
  "무슨말",
  "알려주세요",
  "알려줘요",
  "알려줘",
  "알려줄래",
  "설명해주세요",
  "설명해줘요",
  "설명해줘",
  "설명좀",
  "궁금해요",
  "궁금해",
  "궁금합니다",
];

// 후행 조사 (어미 제거 후 남는 것)
const TRAILING_PARTICLES = ["이란", "란", "이라는게", "라는게", "이", "가", "은", "는", "을", "를", "요"];

/** 소문자·NFKC·공백/문장부호 제거만 수행 (사전 키 생성용) */
export function normalizeKey(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u00a0]+/g, "")
    .replace(/[?!.,~‥…'"“”‘’()\[\]{}<>:;·\-_/\\]+/g, "");
}

/** 질문 전체 정규화: normalizeKey + 질문형 어미/후행 조사 축약 (캐시 키·사전 매칭용) */
export function normalizeQuestion(text: string): string {
  let s = normalizeKey(text);
  // 어미 → 조사 순으로 최대 몇 회 반복 제거 ("보크가+뭐야" → "보크가" → "보크")
  for (let i = 0; i < 3; i++) {
    const before = s;
    for (const suffix of QUESTION_SUFFIXES) {
      if (s.length > suffix.length && s.endsWith(suffix)) {
        s = s.slice(0, -suffix.length);
        break;
      }
    }
    for (const particle of TRAILING_PARTICLES) {
      if (s.length > particle.length && s.endsWith(particle)) {
        s = s.slice(0, -particle.length);
        break;
      }
    }
    if (s === before) break;
  }
  return s;
}
