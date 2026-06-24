import type { ReactNode } from "react";

// http(s):// 또는 www. 로 시작하는 URL. 닫는 괄호/따옴표 등은 매치에서 제외.
const URL_REGEX_G = /(?:https?:\/\/|www\.)[^\s<>"')\]]+/g;
// URL 끝에 붙은 문장부호는 링크에서 제외(예: "...링크." 의 마침표)
const TRAILING_PUNCT = /[.,!?)\]}'"…]+$/;

/**
 * 평문 텍스트의 URL을 클릭 가능한 <a>로 변환해 ReactNode 배열로 반환.
 * URL 외 텍스트는 그대로(React 자동 이스케이프) 렌더 — dangerouslySetInnerHTML 미사용.
 */
export function linkifyText(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  URL_REGEX_G.lastIndex = 0;

  while ((m = URL_REGEX_G.exec(text)) !== null) {
    const matched = m[0].replace(TRAILING_PUNCT, "");
    if (!matched) continue;
    const start = m.index;
    if (start > last) nodes.push(text.slice(last, start));
    const href = matched.startsWith("http") ? matched : `https://${matched}`;
    nodes.push(
      <a
        key={`lnk-${key++}`}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="underline break-all"
      >
        {matched}
      </a>,
    );
    last = start + matched.length; // 뒤 문장부호는 다음 평문 슬라이스에 포함
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
