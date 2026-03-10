# 밈 에디터 MVP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild photo post creation as 3-step flow with Fabric.js meme editor (text/stickers/templates), GamePicker, PlayerTagger, and HashtagInput.

**Architecture:** Fabric.js canvas wrapped in React hook (`useCanvas`) powers the editor. WritePhotoPost becomes a 3-step wizard (media → edit → info). New community components (GamePicker, PlayerTagger, HashtagInput) handle metadata. SVG stickers are inline-defined in a constants file.

**Tech Stack:** Next.js 15, Fabric.js 7.x, React 19, Framer Motion, Tailwind CSS 4, Supabase

---

### Task 1: useCanvas Hook + MemeEditor Shell

**Files:**
- Create: `src/components/editor/useCanvas.ts`
- Create: `src/components/editor/MemeEditor.tsx`

**Description:** Fabric.js canvas initialization hook + wrapper component. Canvas auto-sizes to mobile viewport width, loads image as background, dark bg (#0A0A0B).

**useCanvas.ts:**
- `useCanvas(containerRef)` → returns `{ canvas, loadImage, exportBlob }`
- Init `fabric.Canvas` on mount, dispose on unmount
- `loadImage(url)` sets background image, scales to canvas width maintaining aspect ratio
- `exportBlob()` returns `canvas.toBlob('image/jpeg', 0.9)` as File

**MemeEditor.tsx:**
- Props: `imageUrl: string`, `onSave: (file: File) => void`, `onCancel: () => void`
- Full-screen overlay with canvas + EditorToolbar
- "완료" button calls exportBlob → onSave
- Header with back button + save button

**Commit:** `feat: add useCanvas hook + MemeEditor shell`

---

### Task 2: TextTool

**Files:**
- Create: `src/components/editor/TextTool.tsx`

**Description:** Bottom panel for adding/styling text on canvas.

**Features:**
- "텍스트 추가" button → adds `fabric.IText` at canvas center
- Style presets: 밈체 (Impact, white fill, black stroke width 3), 고딕 (Pretendard, white), 손글씨 (cursive font)
- Color presets: white, black, red (#FF453A), blue (#007AFF), yellow (#FFD60A)
- Font size slider (20-80)
- When a text object is selected, panel shows its current style
- Applies style changes to selected text object

**Commit:** `feat: add TextTool with style presets`

---

### Task 3: SVG Sticker Assets + StickerTool

**Files:**
- Create: `src/components/editor/stickerData.ts` (inline SVG strings + metadata)
- Create: `src/components/editor/StickerTool.tsx`

**Description:** 20+ SVG stickers organized by category, displayed in grid panel.

**Categories & stickers (inline SVG):**
- 🔥 인기 (8): "실화?", "ㅋㅋㅋ", "ㄷㄷ", "레전드", "이게 야구다", "홈런!", "삼진!", "인정"
- ⚾ 야구 (6): 야구공, 배트, 글러브, 헬멧, 스코어보드, 메가폰
- 😂 밈텍스트 (7): "미쳤다", "갓", "핵", "역대급", "오지다", "꿀잼", "노잼"
- 💬 말풍선 (3): 둥근말풍선, 외침말풍선, 생각말풍선

**StickerTool.tsx:**
- Category tabs at top
- Grid of sticker thumbnails (4 columns)
- Tap → `fabric.loadSVGFromString` → add to canvas center, scaled to ~25% of canvas width
- Draggable + resizable via Fabric.js defaults

**Commit:** `feat: add sticker assets + StickerTool`

---

### Task 4: TemplateTool

**Files:**
- Create: `src/components/editor/TemplateTool.tsx`

**Description:** 3 meme templates that auto-place text objects.

**Templates:**
1. "상/하단 텍스트" — Adds 2 IText objects (Impact, white+black stroke) at top center and bottom center
2. "캡션바" — Adds black rect at bottom 15% of canvas + white IText centered on it
3. "직관인증" — Adds frame-like border rect + date/stadium text at bottom

**Each template:**
- Clears existing objects (confirm if objects exist)
- Adds template objects
- Template cards show preview thumbnail

**Commit:** `feat: add TemplateTool with 3 meme templates`

---

### Task 5: EditorToolbar

**Files:**
- Create: `src/components/editor/EditorToolbar.tsx`

**Description:** Bottom tab bar for tool switching.

**Tabs:** [📝텍스트] [😄스티커] [📐템플릿]
- Fixed at bottom, bg-bg-secondary, border-t border-border
- Active tab highlighted with accent color
- Clicking tab toggles the corresponding tool panel (slides up from bottom)
- Panel height: ~40% of viewport
- Tapping active tab closes panel

**Integration with MemeEditor:** MemeEditor renders EditorToolbar which conditionally renders TextTool/StickerTool/TemplateTool.

**Commit:** `feat: add EditorToolbar with tool panels`

---

### Task 6: WritePhotoPost 3-Step Rebuild

**Files:**
- Modify: `src/components/community/WritePhotoPost.tsx` (full rewrite)

**Description:** Transform from single-form to 3-step wizard.

**Step indicator:** 3 dots at top (● ○ ○ style), animated transitions

**Step 1 — 미디어 선택:**
- Reuse existing image picker logic (max 3, compression)
- Horizontal scroll preview + delete buttons
- "다음" button (disabled if 0 images)

**Step 2 — 밈 편집 (optional):**
- Show thumbnails of selected images
- "편집" button on each → opens MemeEditor for that image
- "건너뛰기" button to skip to Step 3
- When editor saves, replace that image's file with edited version
- "다음" button

**Step 3 — 정보 입력:**
- Small thumbnail preview row
- Caption textarea
- GamePicker component
- PlayerTagger component (visible when game selected)
- HashtagInput component
- "게시하기" button → compress + upload + createPost

**Commit:** `feat: rebuild WritePhotoPost as 3-step wizard`

---

### Task 7: GamePicker

**Files:**
- Create: `src/components/community/GamePicker.tsx`

**Description:** Game selection for linking posts to games.

**Features:**
- Fetches recent games (last 24h) from `games` table via Supabase
- Falls back to showing "오늘 경기 없음" if no games
- Card UI: team logos + "팀A vs 팀B · 날짜 · 구장"
- User's team (from profile) games shown first
- "연결 안 함" option
- Single-select (tap to toggle)
- Props: `selectedGameId`, `onSelect(game | null)`

**Commit:** `feat: add GamePicker component`

---

### Task 8: PlayerTagger + HashtagInput

**Files:**
- Create: `src/components/community/PlayerTagger.tsx`
- Create: `src/components/community/HashtagInput.tsx`

**PlayerTagger:**
- When game is linked: show both teams' players as chip list from players constants
- Chip toggle (tap to tag/untag)
- When no game: show search input with player name filtering
- Props: `gameId?`, `selectedPlayers`, `onToggle(player)`

**HashtagInput:**
- Auto-generate tags based on: game (team names), players (player names), always "#직관"
- Show as removable chips
- Text input for custom tags (# auto-prefix)
- Props: `autoTags`, `customTags`, `onUpdate(tags)`

**Commit:** `feat: add PlayerTagger + HashtagInput`

---

### Task 9: usePosts Modification

**Files:**
- Modify: `src/lib/supabase/usePosts.ts`

**Description:** Add game_id, player_tags, hashtags to createPost.

**Changes:**
- Add optional params to `createPost`: `gameId?: string`, `playerTags?: string[]`, `hashtags?: string[]`
- Include in insert: `game_id`, `player_tags`, `hashtags`
- Don't break existing callers (all new params are optional)

**Commit:** `feat: extend createPost with game/player/hashtag fields`

---

### Task 10: Integration + Build Verification

**Steps:**
1. Verify all imports resolve
2. Run `npm run build` — fix any TypeScript/ESLint errors
3. Manual smoke test checklist

**Commit:** `fix: resolve build errors` (if needed)
