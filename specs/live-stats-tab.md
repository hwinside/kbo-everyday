# Live Stats Tab - 이닝별 주요 기록 (경기 중 스탯 탭)

## 목표
경기 진행 중 스탯 탭에서 "경기 진행 중입니다" 경고 대신, 이닝별 주요 기록(타석 결과)을 실시간으로 보여준다.
경기 종료 후에는 기존 풀 BoxScore(GameStatsTab)를 그대로 보여준다.

## 데이터 소스: 네이버 스포츠 API

### Relay API (이닝별 문자중계)
```
GET https://api-gw.sports.naver.com/schedule/games/{naverGameId}/relay?inning={inningNumber}
```

**gameId 매핑:**
- 우리 gameId: `20260315LGLT0` (KBO G_ID 형식)
- 네이버 gameId: `20260315LGLT02026` (뒤에 시즌년도 4자리 추가)
- 변환: `naverGameId = kboGameId + seasonYear` (예: `20260315LGLT0` → `20260315LGLT02026`)

### 응답 구조
```json
{
  "code": 200,
  "success": true,
  "result": {
    "textRelayData": {
      "gameId": "20260315LGLT02026",
      "inn": 4,                    // 현재 이닝
      "currentInning": "4회초",
      "inningScore": {
        "away": {"1": "1", "2": "0", "3": "0", "4": "2"},
        "home": {"1": "0", "2": "1", "3": "0", "4": "-"}
      },
      "textRelays": [
        {
          "title": "3번타자 홍창기",
          "titleStyle": "8",       // "8" = 타자 타석, "0" = 이닝 시작 헤더
          "textOptions": [
            {"seqno": 16, "text": "1구 스트라이크", "type": 1, "speed": "151", "stuff": "직구"},
            {"seqno": 18, "text": "홍창기 : 우익수 앞 1루타", "type": 13},
            {"seqno": 19, "text": "1루주자 홍창기 : 2루까지 진루", "type": 14}
          ]
        },
        {
          "title": "1회초 LG 공격",
          "titleStyle": "0"
        }
      ]
    }
  }
}
```

### textOptions type 의미
- `type: 1` → 투구 (스트라이크, 볼 등) — **무시**
- `type: 7` → 투수 이벤트 (투수판 이탈 등) — **무시**
- `type: 8` → 타자 등장 헤더 — **무시** (title에서 이미 보임)
- `type: 13` → **타석 결과** (핵심! "홍창기 : 우익수 앞 1루타", "오지환 : 솔로 홈런")
- `type: 14` → **주루 이벤트** ("1루주자 홍창기 : 2루까지 진루") — 득점 관련만 표시

### 주요 기록 추출 규칙
textRelays 배열에서:
1. `titleStyle === "0"` → 이닝 시작 헤더 (예: "1회초 LG 공격") → **이닝 구분자로 사용**
2. `titleStyle === "8"` → 타자 타석 → textOptions에서 `type: 13`인 것이 **타석 결과**
3. 결과 텍스트 포맷: `"선수명 : 결과"` (예: "홍창기 : 우익수 앞 1루타")

### 표시할 이벤트 (type: 13에서 필터)
아래 키워드를 포함하는 결과만 표시:
- **안타**: "1루타", "2루타", "3루타"
- **홈런**: "홈런"
- **볼넷**: "볼넷"
- **삼진**: "삼진"
- **아웃**: "아웃" (플라이, 땅볼 등)
- **몸에 맞는 볼**: "몸에 맞는 볼"
- **실책**: "실책"
- **희생**: "희생"

→ 사실상 type: 13인 결과는 **전부 표시**하면 됨. 이미 핵심 타석 결과만 옴.

### 특수 이벤트 (type: 14에서 선별)
- 득점: "홈까지 진루" 또는 "득점" 포함 시 표시
- 도루: "도루" 포함 시 표시  
- 나머지 주루 이벤트는 무시 (폭투 진루 등은 노이즈)

## 구현 범위

### 1. API Route: `/api/game-relay/route.ts`

```typescript
// GET /api/game-relay?gameId=20260315LGLT0
// Response:
interface GameRelayResponse {
  gameId: string;
  currentInning: number;
  innings: InningRelay[];
}

interface InningRelay {
  inning: number;        // 1, 2, 3...
  half: "top" | "bottom"; // 초/말
  teamName: string;      // "LG", "롯데"
  plays: PlayEvent[];
}

interface PlayEvent {
  batterName: string;    // "홍창기"
  result: string;        // "우익수 앞 1루타"
  type: "hit" | "homerun" | "walk" | "strikeout" | "out" | "hbp" | "sacrifice" | "error" | "other";
  extras?: string[];     // 주루 이벤트 (득점, 도루)
}
```

**구현 상세:**
- 1~currentInning까지 순차적으로 네이버 relay API를 호출 (Promise.all로 병렬)
- `textRelays` 배열은 **역순** (최신→과거) → 뒤집어서 시간순으로 정렬
- inningScore 데이터도 함께 반환하면 좋지만 필수는 아님 (이미 linescore에서 보여줌)
- revalidate: 30초

**GameId 변환 함수:**
```typescript
function toNaverGameId(kboGameId: string): string {
  // "20260315LGLT0" → "20260315LGLT02026"
  const year = kboGameId.slice(0, 4);
  return kboGameId + year;
}
```

**타석 결과 분류:**
```typescript
function classifyResult(text: string): PlayEvent["type"] {
  if (text.includes("홈런")) return "homerun";
  if (text.includes("1루타") || text.includes("2루타") || text.includes("3루타")) return "hit";
  if (text.includes("볼넷")) return "walk";
  if (text.includes("삼진")) return "strikeout";
  if (text.includes("몸에 맞는 볼")) return "hbp";
  if (text.includes("희생")) return "sacrifice";
  if (text.includes("실책")) return "error";
  if (text.includes("아웃")) return "out";
  return "other";
}
```

### 2. React Hook: `useGameRelay`

```typescript
// src/lib/hooks/useGameRelay.ts
function useGameRelay(gameId: string, isLive: boolean, interval?: number): {
  data: GameRelayResponse | null;
  isLoading: boolean;
}
```
- isLive가 false이면 fetch하지 않음
- interval 기본값: 30000 (30초)

### 3. Component: `LiveStatsTab.tsx`

```typescript
// src/components/game/LiveStatsTab.tsx
interface LiveStatsTabProps {
  relay: GameRelayResponse;
  awayTeam: TeamData;
  homeTeam: TeamData;
}
```

**UI 디자인 (다크모드, 기존 디자인 시스템 따르기):**

```
┌─────────────────────────────┐
│  📍 이닝별 주요 기록         │
│  경기 종료 후 전체 스탯 제공  │  ← 작은 안내 문구
├─────────────────────────────┤
│                             │
│  1회초 · LG                 │  ← 이닝 헤더 (팀 컬러 액센트)
│  ├ 이재원  볼넷             │
│  ├ 천성호  2루수 앞 땅볼 출루 │
│  ├ 홍창기  우익수 앞 1루타 ⚾ │  ← 안타/홈런 하이라이트
│  ├ 오스틴  희생플라이         │
│  └ 문성주  좌익수 플라이 아웃 │
│                             │
│  1회말 · 롯데               │
│  ├ 레이예스  좌익수 플라이 아웃│
│  ├ 한태양   우익수 플라이 아웃│
│  ├ 윤동희   좌익수 앞 1루타 ⚾│
│  ├ 전준우   볼넷             │
│  └ 유강남   3루수 앞 땅볼    │
│                             │
│  2회초 · LG                 │
│  ...                        │
└─────────────────────────────┘
```

**디자인 요소:**
- glass-card 배경 (기존 컴포넌트 패턴)
- 이닝 헤더: 팀 colorPrimary로 좌측 바 + 팀 shortName
- 각 타석 결과는 한 줄: `선수명   결과`
- 안타/홈런은 accent 컬러(기존 text-accent)로 하이라이트
- 홈런은 ⚾ 이모지 또는 🔥 추가
- 삼진은 약간 dim 처리 (text-text-tertiary)
- 볼넷/몸맞볼은 기본 색상
- 득점 이벤트가 있으면 결과 옆에 `+1` 뱃지
- 이닝 결과 점수도 이닝 헤더에 표시: "1회초 · LG · 1점"

**최신 이닝이 위에 오도록 역순 정렬** (최근 경기 흐름을 바로 볼 수 있게)

### 4. 페이지 통합: `games/[gameId]/page.tsx`

기존 스탯 탭 렌더링 부분 수정:

```tsx
{activeTab === "stats" && (
  <motion.div key="stats" ...>
    {gameStats ? (
      // 경기 종료 후: 기존 풀 BoxScore
      <GameStatsTab stats={gameStats} awayTeam={awayTeam} homeTeam={homeTeam} />
    ) : liveGame?.isLive ? (
      // 경기 중: 이닝별 주요 기록
      <LiveStatsTab relay={gameRelay} awayTeam={awayTeam} homeTeam={homeTeam} />
    ) : (
      // 경기 전: 기존 메시지
      <div>...</div>
    )}
  </motion.div>
)}
```

## 파일 목록
1. **NEW** `src/app/api/game-relay/route.ts` — 네이버 relay API 프록시
2. **NEW** `src/lib/hooks/useGameRelay.ts` — SWR 훅
3. **NEW** `src/components/game/LiveStatsTab.tsx` — 라이브 이닝별 기록 UI
4. **EDIT** `src/app/(main)/games/[gameId]/page.tsx` — 스탯 탭에서 LiveStatsTab 연동

## 주의사항
- 네이버 API는 서버사이드에서만 호출 (CORS 회피)
- API 에러 시 graceful fallback: "경기 종료 후 전체 스탯을 제공합니다" 메시지
- revalidate 30초 → 클라이언트 polling도 30초
- 이닝 수가 많으면 호출 수도 늘어남 → 최대 15이닝까지만 (연장 포함)
- textRelays 배열이 빈 이닝은 건너뛰기
- 다크모드(#0A0A0B) 기반, 기존 glass-card/text-accent 등 디자인 토큰 사용

## 검증
- `npm run build` (tsc 0 errors)
- 시범경기 라이브 중 스탯 탭 → 이닝별 기록 표시 확인
- 경기 종료 후 스탯 탭 → 기존 풀 BoxScore 표시 확인
- 네이버 API 실패 시 → fallback 메시지 표시 확인
