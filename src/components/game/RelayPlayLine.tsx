import type { PlayEvent } from "@/app/api/game-relay/route";

/**
 * 실시간 문자중계 한 타석(플레이) 렌더 — 크관 탭(KgwanTab) 이전/현재 이닝 공용.
 *
 * 폰트 단일 소스: 본문 text-sm(14px), 보조(extras) text-xs(12px).
 * (과거 기록 UI 14px와 통일 — PR: 중계 글자 확대)
 * QA fixture(/qa/relay-font)도 이 컴포넌트를 그대로 사용하므로 마크업 drift가 없다.
 */
export function playEmoji(type: PlayEvent["type"]): string {
  switch (type) {
    case "homerun": return "💥";
    case "hit": return "🔵";
    case "walk": return "🟡";
    case "hbp": return "🟡";
    case "strikeout": return "🔴";
    case "out": return "⚪";
    case "sacrifice": return "⚪";
    case "error": return "⚠️";
    default: return "⚾";
  }
}

export default function RelayPlayLine({ play }: { play: PlayEvent }) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-xs mt-0.5 w-4 text-center shrink-0">{playEmoji(play.type)}</span>
      <div className="flex-1 min-w-0">
        <p data-qa="relay-body" className="text-sm text-text-primary leading-relaxed">
          <span className="font-semibold">{play.batterName}</span>
          <span className="text-text-secondary ml-1.5">{play.result}</span>
        </p>
        {play.extras && play.extras.length > 0 && (
          <p data-qa="relay-aux" className="text-xs leading-relaxed mt-0.5" style={{ color: "var(--relay-sub-text)" }}>
            └ {play.extras.join(" / ")}
          </p>
        )}
      </div>
    </div>
  );
}
