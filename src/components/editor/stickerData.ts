export interface StickerItem {
  id: string;
  label: string;
  svg: string;
}

export interface StickerCategory {
  id: string;
  emoji: string;
  label: string;
  items: StickerItem[];
}

function textBubbleSvg(text: string, color = "#FFD60A", bgColor = "transparent"): string {
  const fontSize = text.length <= 2 ? 42 : text.length <= 4 ? 32 : 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
    <rect width="120" height="60" rx="12" fill="${bgColor}"/>
    <text x="60" y="38" text-anchor="middle" font-size="${fontSize}" font-weight="900" fill="${color}" font-family="Impact, Arial Black, sans-serif" stroke="#000" stroke-width="2" paint-order="stroke">${text}</text>
  </svg>`;
}

const popular: StickerItem[] = [
  { id: "pop-1", label: "실화?", svg: textBubbleSvg("실화?", "#FF453A") },
  { id: "pop-2", label: "ㅋㅋㅋ", svg: textBubbleSvg("ㅋㅋㅋ", "#FFD60A") },
  { id: "pop-3", label: "ㄷㄷ", svg: textBubbleSvg("ㄷㄷ", "#FFFFFF") },
  { id: "pop-4", label: "레전드", svg: textBubbleSvg("레전드", "#FFD60A") },
  {
    id: "pop-5", label: "이게 야구다",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60">
      <text x="80" y="42" text-anchor="middle" font-size="26" font-weight="900" fill="#FF453A" font-family="Impact, Arial Black, sans-serif" stroke="#000" stroke-width="2" paint-order="stroke">이게 야구다</text>
    </svg>`,
  },
  { id: "pop-6", label: "홈런!", svg: textBubbleSvg("홈런!", "#30D158") },
  { id: "pop-7", label: "삼진!", svg: textBubbleSvg("삼진!", "#007AFF") },
  { id: "pop-8", label: "인정", svg: textBubbleSvg("인정", "#FFFFFF") },
];

const baseball: StickerItem[] = [
  {
    id: "bb-1", label: "야구공",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <circle cx="40" cy="40" r="36" fill="#F5F5F7" stroke="#CC0000" stroke-width="2"/>
      <path d="M22 18 Q30 30 22 44 Q16 56 22 65" fill="none" stroke="#CC0000" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M58 18 Q50 30 58 44 Q64 56 58 65" fill="none" stroke="#CC0000" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="20" y1="22" x2="24" y2="24" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="18" y1="28" x2="23" y2="29" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="18" y1="34" x2="22" y2="34" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="18" y1="40" x2="22" y2="40" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="19" y1="46" x2="23" y2="45" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="20" y1="52" x2="24" y2="50" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="60" y1="22" x2="56" y2="24" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="62" y1="28" x2="57" y2="29" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="62" y1="34" x2="58" y2="34" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="62" y1="40" x2="58" y2="40" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="61" y1="46" x2="57" y2="45" stroke="#CC0000" stroke-width="1.5"/>
      <line x1="60" y1="52" x2="56" y2="50" stroke="#CC0000" stroke-width="1.5"/>
    </svg>`,
  },
  {
    id: "bb-2", label: "배트",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <rect x="36" y="8" width="8" height="52" rx="4" fill="#D4A76A" transform="rotate(-15 40 34)"/>
      <rect x="34" y="52" width="12" height="20" rx="3" fill="#8B6914" transform="rotate(-15 40 62)"/>
      <rect x="35" y="50" width="10" height="4" rx="1" fill="#333" transform="rotate(-15 40 52)"/>
    </svg>`,
  },
  {
    id: "bb-3", label: "글러브",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <ellipse cx="40" cy="42" rx="28" ry="30" fill="#8B4513"/>
      <ellipse cx="40" cy="42" rx="20" ry="22" fill="#A0522D"/>
      <path d="M20 30 Q15 20 20 12 Q25 8 28 16 L24 30Z" fill="#8B4513"/>
      <path d="M28 22 Q26 12 30 6 Q35 2 36 12 L32 24Z" fill="#8B4513"/>
      <path d="M36 18 Q36 8 40 4 Q44 2 44 12 L40 22Z" fill="#8B4513"/>
      <path d="M44 18 Q46 8 50 6 Q54 4 52 14 L48 24Z" fill="#8B4513"/>
      <path d="M52 24 Q56 16 60 16 Q64 18 58 28 L54 30Z" fill="#8B4513"/>
      <path d="M28 38 Q40 32 52 38" fill="none" stroke="#6B3410" stroke-width="2"/>
    </svg>`,
  },
  {
    id: "bb-4", label: "헬멧",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <path d="M16 50 Q16 16 40 12 Q64 16 64 50 L60 54 Q58 56 54 56 L44 56 Q44 48 36 48 Q28 48 28 56 L20 56 Q18 56 16 54Z" fill="#1C1C1F"/>
      <ellipse cx="40" cy="20" rx="20" ry="8" fill="#2A2A2E"/>
      <rect x="26" y="48" width="14" height="10" rx="5" fill="#2A2A2E" stroke="#1C1C1F" stroke-width="1"/>
    </svg>`,
  },
  {
    id: "bb-5", label: "스코어보드",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60">
      <rect x="4" y="4" width="112" height="52" rx="6" fill="#1A1A1A" stroke="#333" stroke-width="2"/>
      <text x="30" y="28" font-size="12" fill="#8E8E93" font-family="monospace">HOME</text>
      <text x="78" y="28" font-size="12" fill="#8E8E93" font-family="monospace">AWAY</text>
      <text x="30" y="46" font-size="20" font-weight="bold" fill="#30D158" font-family="monospace">0</text>
      <text x="60" y="46" font-size="16" fill="#636366" font-family="monospace" text-anchor="middle">:</text>
      <text x="78" y="46" font-size="20" font-weight="bold" fill="#FF453A" font-family="monospace">0</text>
    </svg>`,
  },
  {
    id: "bb-6", label: "메가폰",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
      <polygon points="20,28 20,52 30,52 56,66 56,14 30,28" fill="#FF453A"/>
      <rect x="12" y="32" width="10" height="16" rx="3" fill="#CC0000"/>
      <circle cx="56" cy="40" r="4" fill="#FFD60A"/>
      <path d="M62 24 Q70 32 70 40 Q70 48 62 56" fill="none" stroke="#FFD60A" stroke-width="2.5" stroke-linecap="round"/>
      <path d="M66 18 Q78 28 78 40 Q78 52 66 62" fill="none" stroke="#FFD60A" stroke-width="2" stroke-linecap="round" opacity="0.6"/>
    </svg>`,
  },
];

const memeText: StickerItem[] = [
  { id: "mt-1", label: "미쳤다", svg: textBubbleSvg("미쳤다", "#FF453A") },
  { id: "mt-2", label: "갓", svg: textBubbleSvg("갓", "#FFD60A") },
  { id: "mt-3", label: "핵", svg: textBubbleSvg("핵", "#FF453A") },
  { id: "mt-4", label: "역대급", svg: textBubbleSvg("역대급", "#FFD60A") },
  { id: "mt-5", label: "오지다", svg: textBubbleSvg("오지다", "#30D158") },
  { id: "mt-6", label: "꿀잼", svg: textBubbleSvg("꿀잼", "#FFD60A") },
  { id: "mt-7", label: "노잼", svg: textBubbleSvg("노잼", "#8E8E93") },
];

const balloons: StickerItem[] = [
  {
    id: "bl-1", label: "둥근 말풍선",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
      <path d="M10 10 Q10 4 16 4 L124 4 Q130 4 130 10 L130 64 Q130 70 124 70 L50 70 L30 90 L36 70 L16 70 Q10 70 10 64Z" fill="white" stroke="#E0E0E0" stroke-width="1.5"/>
    </svg>`,
  },
  {
    id: "bl-2", label: "외침 말풍선",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
      <polygon points="70,2 130,8 136,30 128,60 100,72 60,90 50,68 8,64 4,32 14,8" fill="#FFD60A" stroke="#E6C000" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`,
  },
  {
    id: "bl-3", label: "생각 말풍선",
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 140 100">
      <ellipse cx="70" cy="38" rx="58" ry="32" fill="white" stroke="#E0E0E0" stroke-width="1.5"/>
      <ellipse cx="34" cy="76" rx="10" ry="8" fill="white" stroke="#E0E0E0" stroke-width="1.5"/>
      <ellipse cx="20" cy="90" rx="6" ry="5" fill="white" stroke="#E0E0E0" stroke-width="1.5"/>
    </svg>`,
  },
];

export const STICKER_CATEGORIES: StickerCategory[] = [
  { id: "popular", emoji: "🔥", label: "인기", items: popular },
  { id: "baseball", emoji: "⚾", label: "야구", items: baseball },
  { id: "meme", emoji: "😂", label: "밈텍스트", items: memeText },
  { id: "balloon", emoji: "💬", label: "말풍선", items: balloons },
];
