/**
 * 움짤콜렉터 슬랙 인박스 메시지 파서.
 *
 * 입력 형식 (멀티라인):
 *   <URL>
 *   팀 선수
 *   본문 (선택, 1줄 이상 자유)
 *
 * 슬랙은 URL을 `<https://...>` 또는 `<https://...|label>`로 자동 변환하므로
 * 두 패턴 모두 지원한다. 본문은 옵션(0줄도 허용).
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

function extractFirstUrl(line: string): string | null {
  const slack = line.match(SLACK_LINK_RE);
  if (slack) return slack[1];
  const plain = line.match(URL_RE);
  return plain ? plain[0] : null;
}

export function parseInboxMessage(text: string): ParseResult {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return {
      ok: false,
      error: "최소 2줄 필요 (1줄: URL, 2줄: '팀 선수'). 본문은 3줄째부터 옵션.",
    };
  }

  const url = extractFirstUrl(lines[0]);
  if (!url) {
    return { ok: false, error: "첫 줄에서 URL 인식 실패. https://... 형태여야 합니다." };
  }

  const metaTokens = lines[1].split(/\s+/);
  if (metaTokens.length < 2) {
    return {
      ok: false,
      error: "둘째 줄 형식: '팀 선수' (공백 구분). 예: 'LG 오스틴'",
    };
  }
  const [teamName, ...playerParts] = metaTokens;
  const playerName = playerParts.join(" ");

  const body = lines.slice(2).join("\n");

  return { ok: true, value: { url, teamName, playerName, body } };
}
