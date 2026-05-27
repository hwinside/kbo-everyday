/**
 * 움짤콜렉터 슬랙 인박스 메시지 파서.
 *
 * 두 가지 형식 모두 허용 (forgiving parser):
 *
 *   1) 키-값 형식 (삼순이 권고, 명시적):
 *      팀: LG
 *      선수: 오스틴            (선택 — 생략 시 팀 사진 게시판으로 라우팅)
 *      링크: https://...
 *      본문: 시즌 첫 그랜드슬램.
 *      진짜 미쳤다.
 *
 *   2) 멀티라인 형식 (운영자 합의, 빠른 입력):
 *      <URL>
 *      팀 [선수]                (둘째 토큰 생략 시 팀 사진 게시판으로 라우팅)
 *      본문 (선택, 1줄 이상 자유)
 *
 * playerName이 빈 문자열이면 caller가 "팀 사진 게시판" 라우팅으로 분기한다.
 *
 * 본문은 *원본 그대로 보존* — 빈 줄과 앞뒤 공백을 죽이지 않는다 (게시판 콘텐츠가
 * 그대로 노출됨).
 */

export interface ParsedInboxMessage {
  url: string;
  teamName: string;
  playerName: string;
  body: string;
}

export type ParseResult =
  | { ok: true; value: ParsedInboxMessage }
  | { ok: false; error: string };

const URL_RE = /https?:\/\/\S+/;
const SLACK_LINK_RE = /<(https?:\/\/[^|>]+)(?:\|[^>]*)?>/;
const KV_RE = /^\s*(팀|선수|링크|본문|team|player|link|url|body)\s*:\s*(.*)$/i;

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractFirstUrl(s: string): string | null {
  const slack = s.match(SLACK_LINK_RE);
  if (slack) return decodeHtmlEntities(slack[1]);
  const plain = s.match(URL_RE);
  return plain ? decodeHtmlEntities(plain[0]) : null;
}

function normalizeKvKey(raw: string): "team" | "player" | "url" | "body" | null {
  const k = raw.trim().toLowerCase();
  if (k === "팀" || k === "team") return "team";
  if (k === "선수" || k === "player") return "player";
  if (k === "링크" || k === "link" || k === "url") return "url";
  if (k === "본문" || k === "body") return "body";
  return null;
}

function tryKvParse(text: string): ParseResult | null {
  const lines = text.split(/\r?\n/);
  const meta: { team?: string; player?: string; url?: string; body?: string } = {};
  let bodyStartIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(KV_RE);
    if (!m) continue;
    const key = normalizeKvKey(m[1]);
    if (!key) continue;
    const val = m[2];
    if (key === "body") {
      // body 라인 이후의 모든 줄을 *원본 그대로* (trim/filter 금지).
      const inline = val.replace(/^\s+/, "").replace(/\s+$/, "");
      const rest = lines.slice(i + 1).join("\n");
      meta.body =
        inline.length === 0 && rest.length > 0
          ? rest
          : inline + (rest.length > 0 ? "\n" + rest : "");
      bodyStartIdx = i;
      break;
    }
    if (key === "url") meta.url = extractFirstUrl(val) ?? val.trim();
    else meta[key] = val.trim();
  }

  // 키-값 신호가 전혀 없으면 멀티라인 모드로 fallback
  if (!meta.team && !meta.player && !meta.url && bodyStartIdx === -1) return null;

  // 선수는 선택 — 빠지면 팀 사진 게시판 경로로 라우팅됨.
  const missing: string[] = [];
  if (!meta.team) missing.push("팀");
  if (!meta.url) missing.push("링크");
  if (missing.length > 0) {
    return { ok: false, error: `키-값 형식 누락: ${missing.join(", ")}` };
  }

  return {
    ok: true,
    value: {
      url: meta.url!,
      teamName: meta.team!,
      playerName: meta.player ?? "",
      body: meta.body ?? "",
    },
  };
}

function tryMultilineParse(text: string): ParseResult {
  const lines = text.split(/\r?\n/);
  // 첫 비어있지 않은 줄 = URL 라인, 둘째 비어있지 않은 줄 = 팀+선수 라인.
  // 본문은 메타 라인 *다음 위치*부터 원본 그대로.
  let urlLineIdx = -1;
  let metaLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length === 0) continue;
    if (urlLineIdx === -1) urlLineIdx = i;
    else if (metaLineIdx === -1) {
      metaLineIdx = i;
      break;
    }
  }

  if (urlLineIdx === -1 || metaLineIdx === -1) {
    return {
      ok: false,
      error:
        "최소 2줄 필요. 형식: 1줄 URL, 2줄 '팀 [선수]', 3줄부터 본문(선택). 또는 키-값(`팀:`, `선수:` (선택), `링크:`, `본문:`).",
    };
  }

  const url = extractFirstUrl(lines[urlLineIdx]);
  if (!url) return { ok: false, error: "첫 의미 있는 줄에서 URL 인식 실패." };

  const metaTokens = lines[metaLineIdx].trim().split(/\s+/);
  // 1토큰 = 팀명만 → 팀 사진 게시판 경로 (playerName="")
  // 2토큰+ = 팀 + 선수 → 선수 사진 게시판 경로
  const [teamName, ...playerParts] = metaTokens;
  const playerName = playerParts.join(" ");

  // 본문은 메타 라인 다음부터 원본 그대로 (leading 빈 줄만 제거해 가독성 확보).
  const bodyRaw = lines.slice(metaLineIdx + 1).join("\n");
  const body = bodyRaw.replace(/^\n+/, "");

  return { ok: true, value: { url, teamName, playerName, body } };
}

export function parseInboxMessage(text: string): ParseResult {
  const kv = tryKvParse(text);
  if (kv) return kv;
  return tryMultilineParse(text);
}
