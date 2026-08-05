/**
 * 야잘알봇 답변 **출처 표시** 공용 모듈 (하린아빠 2026-08-05 P0).
 *
 * 왜 별도 모듈인가: 상세 화면·쪽지 목록 미리보기·알림 미리보기가 **같은 규칙**을 써야
 * 한다. 상세에만 적용했더니 목록에 `rev crawled:…` 가 그대로 남았다(삼순 P0-1).
 * 서버 RAG 모듈(`rag/retrieve.ts`)에 두면 클라 번들이 무거워지므로 의존 없는 순수 모듈로
 * 분리하고, 서버는 여기서 가져다 쓴다.
 *
 * 노출 금지 대상: `revision`(특히 `crawled:` 접두)·`crawledAt`·`asOf`·전체 URL·`sectionPath`.
 * 전부 내부 provenance 로는 그대로 유지한다 — 감사·중복제거·정합성 검증에 쓰인다.
 * **표시에서만** 뺀다.
 */

export const PROVENANCE_LABELS = {
  namu: "나무위키",
  wikipedia: "위키피디아",
  official: "KBO 공식 자료",
} as const;
export type ProvenanceLabel = (typeof PROVENANCE_LABELS)[keyof typeof PROVENANCE_LABELS];

/**
 * 출처 링크 **허용 도메인 exact allowlist** (삼순 P0-2).
 *
 * `https://` 접두만 보면 임의 외부 주소가 그대로 `<a href>` 가 되고 `KBO 공식 자료` 라벨까지
 * 달린다. 우리가 실제로 수집하는 소스는 폐쇄집합이므로 hostname 을 정확히 대조한다.
 * 서브도메인 와일드카드를 쓰지 않는다 — `namu.wiki.evil.com` 류를 막기 위해서다.
 */
const ALLOWED_HOSTS: Readonly<Record<string, ProvenanceLabel>> = {
  "namu.wiki": PROVENANCE_LABELS.namu,
  "ko.wikipedia.org": PROVENANCE_LABELS.wikipedia,
  "en.wikipedia.org": PROVENANCE_LABELS.wikipedia,
  "ja.wikipedia.org": PROVENANCE_LABELS.wikipedia,
  "www.koreabaseball.com": PROVENANCE_LABELS.official,
  "koreabaseball.com": PROVENANCE_LABELS.official,
};

/** 유저 노출용 출처 한 건 — 표시명과 링크뿐이다. 내부 메타는 담지 않는다. */
export interface DisplayProvenance {
  label: ProvenanceLabel;
  /** allowlist 밖이거나 파싱 실패면 빈 문자열 — 링크 없이 표시명만 그린다(fail-close). */
  url: string;
}

/**
 * URL 을 **실제 파서로** 해석해 allowlist hostname 을 대조한다.
 * 문자열 `startsWith` 는 `https://namu.wiki@evil.com/` 같은 형태에 뚫린다.
 */
export function resolveAllowedSource(rawUrl: string | null | undefined): DisplayProvenance | null {
  if (!rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  // https 만 허용 — `javascript:`·`data:`·평문 http 전부 거절한다.
  if (parsed.protocol !== "https:") return null;
  // userinfo(`user@host`)가 있으면 호스트를 오독하기 쉬운 형태다. 우리 소스엔 없다.
  if (parsed.username || parsed.password) return null;
  const label = Object.prototype.hasOwnProperty.call(ALLOWED_HOSTS, parsed.hostname)
    ? ALLOWED_HOSTS[parsed.hostname]
    : null;
  if (!label) return null;
  return { label, url: parsed.toString() };
}

/**
 * 근거 한 건에서 유저 노출 출처를 만든다.
 *
 * ⚠️ allowlist 밖이면 **null 이다** (삼순 P0-1, 2026-08-05). 종전 구현은 tier2 면 `나무위키`,
 * tier1 이면 `KBO 공식 자료` 로 폴백했는데, 그건 **출처를 지어내는 것**이다. 실제로는
 * 어디서 왔는지 모르는 근거에 유명 출처 이름을 붙이는 셈이라 링크 노출보다 더 나쁘다.
 * 모르면 출처를 안 붙인다.
 */
export function displayProvenanceOf(evidence: {
  canonicalUrl: string;
  sourceGrade?: string;
}): DisplayProvenance | null {
  return resolveAllowedSource(evidence.canonicalUrl);
}

const LABEL_ALTERNATION = Object.values(PROVENANCE_LABELS).join("|");

/**
 * 구 표기 — 이미 발송돼 `dm_messages` 에 저장된 본문에 남아 있다.
 * `📄 출처: <문서명>[ · <섹션>] (<URL>) · rev <revision> · <YYYY-MM-DD> 기준`
 */
const LEGACY_PROVENANCE_LINE =
  /\n*📄 출처: [^\n]*?\((https?:\/\/[^)\s]+)\)\s*·\s*rev\s+\S+\s*·\s*\d{4}-\d{2}-\d{2} 기준\s*$/;

/** 신규 표기 — 표시명만. 링크는 payload 에 있다. */
const CURRENT_PROVENANCE_LINE = new RegExp(`\\n*📄 출처: (${LABEL_ALTERNATION})\\s*$`);

/**
 * 화면에 그릴 본문과 출처를 분리한다. 신규·구 표기를 한 함수로 처리한다.
 *
 * 구 표기까지 여기서 처리하는 이유: 표기를 바꿔도 저장된 과거 본문은 그대로라 유저는
 * 계속 `rev crawled:…` 를 본다. 저장 행을 UPDATE 하지 않고 **표시 시점에** 정규화한다
 * — 원본 보존이라 롤백이 가능하고 대량 UPDATE 사고 위험이 없다.
 */
export function splitProvenanceForDisplay(
  content: string,
  payloadSourceUrl?: string | null,
): { body: string; provenance: DisplayProvenance | null } {
  const legacy = content.match(LEGACY_PROVENANCE_LINE);
  if (legacy) {
    const body = content.slice(0, legacy.index).trimEnd();
    // 구 본문의 URL 도 allowlist 를 통과해야 링크가 된다. 통과 못 하면 줄만 잘라낸다.
    const allowed = resolveAllowedSource(legacy[1]);
    return { body, provenance: allowed ?? null };
  }
  const current = content.match(CURRENT_PROVENANCE_LINE);
  if (current) {
    const body = content.slice(0, current.index).trimEnd();
    const allowed = resolveAllowedSource(payloadSourceUrl);
    // 링크를 검증하지 못하면 표시명만 남긴다. 본문이 이미 그 이름을 달고 나갔으므로
    // 이름 자체는 지어낸 값이 아니다 — 다만 클릭 가능한 링크는 만들지 않는다.
    return {
      body,
      provenance: allowed ?? { label: current[1] as ProvenanceLabel, url: "" },
    };
  }
  return { body: content, provenance: null };
}

/**
 * 쪽지 목록 미리보기·알림 미리보기용 **한 줄 요약** (삼순 P0-1).
 *
 * 목록은 앵커를 그릴 자리가 없으므로 출처 줄을 통째로 떼고 본문만 보여준다.
 * payload 가 없는 경로(목록 API 는 `last_message` 문자열만 준다)에서도 동작해야 하므로
 * 인자를 본문 하나만 받는다.
 */
export function stripProvenanceForPreview(
  content: string | null | undefined,
  /**
   * 야잘알봇 대화인가. **기본값은 false** — 일반 DM 은 절대 건드리지 않는다(삼순 P1).
   * 정상 유저 문장이 우연히 출처 suffix 와 같은 모양이면 잘려나가기 때문이다.
   */
  isGeniusConversation = false,
): string {
  if (!content) return "";
  if (!isGeniusConversation) return content;
  return splitProvenanceForDisplay(content).body;
}

/**
 * 유저 노출 문자열에 내부 메타가 남아 있는가. 게이트·런타임 양쪽에서 쓰는 단일 판정기.
 * 규칙을 두 곳에 적으면 한쪽만 고쳐져 조용히 새는 사고가 난다.
 */
export const FORBIDDEN_PROVENANCE_PATTERNS: readonly (readonly [string, RegExp])[] = [
  ["crawled", /crawled/i],
  ["rev 접두", /\brev\s+\S/],
  ["기준일", /\d{4}-\d{2}-\d{2}\s*기준/],
  ["평문 URL", /https?:\/\//],
] as const;

export function findLeakedInternalMeta(text: string): string[] {
  return FORBIDDEN_PROVENANCE_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}
