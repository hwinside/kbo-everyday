/**
 * player_tags DB 저장/파싱 유틸
 *
 * 신규 포맷: "69100:구본혁"  → { kboId: "69100", displayName: "구본혁" }
 * 레거시:    "김현수"        → { kboId: null,    displayName: "김현수" }
 */

export function formatPlayerTag(kboId: string, name: string): string {
  return `${kboId}:${name}`;
}

export function parsePlayerTag(tag: string): {
  kboId: string | null;
  displayName: string;
} {
  const colonIdx = tag.indexOf(":");
  if (colonIdx === -1) {
    return { kboId: null, displayName: tag };
  }
  return {
    kboId: tag.slice(0, colonIdx),
    displayName: tag.slice(colonIdx + 1),
  };
}
