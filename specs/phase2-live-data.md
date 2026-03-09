# Phase 2: 실시간 데이터 연동 스펙

## 목표
경기 상세 페이지의 mock 데이터를 KBO 공식 JSON API 실데이터로 교체

## KBO API 엔드포인트 (모두 POST, JSON 응답)

### 1. GetScoreBoard (라인스코어)
```
URL: https://www.koreabaseball.com/ws/Schedule.asmx/GetScoreBoard
Body: leId=1&srId={srId}&seasonId={year}&gameId={gameId}
Content-Type: application/x-www-form-urlencoded

응답: JSON array
  [0] = [{메타: LE_ID, SR_ID, G_ID, G_DT, HOME_NM, AWAY_NM, S_NM, CROWD_CN, T_SCORE_CN, B_SCORE_CN, ...}]
  [1] = [JSON string] → parse하면 { rows: [{row: [{Text: "승"}, {Text: "<span>LG</span>"}, ...이닝별점수..., R, H, E, BB]}] }
       - row[0]: away팀 (첫 컬럼=승/패, 2번째=팀로고HTML, 3~11=1~9회점수, 12~=연장, 마지막4개=R,H,E,BB)
       - row[1]: home팀 (동일 구조)
  경기 전이면 [1]이 없음 (data length = 1)
```

### 2. GetLineUpAnalysis (라인업)
```
URL: https://www.koreabaseball.com/ws/Schedule.asmx/GetLineUpAnalysis
Body: leId=1&srId={srId}&seasonId={year}&gameId={gameId}

응답: JSON array
  [0] = [{LINEUP_CK: true/false}]  // true=금일 라인업, false=최근 라인업
  [1] = [{away팀 정보: T_ID, T_NM, ...}]
  [2] = [{home팀 정보}]
  [3] = [JSON string] → parse하면 { rows: [{row: [{Text:"1"}, {Text:"우익수"}, {Text:"홍창기"}, {Text:"1.23"}]}] }
       - away 라인업 (타순, 포지션명, 선수명, WAR)
  [4] = [JSON string] → home 라인업 (동일 구조)
```

### 3. GetBoxScore (타자/투수 기록)
```
URL: https://www.koreabaseball.com/ws/Schedule.asmx/GetBoxScore
Body: leId=1&srId={srId}&seasonId={year}&gameId={gameId}

응답: JSON object { tables: [...], code: "100", msg: "성공" }
  tables[0] = 경기기록 요약 (결승타, 홈런, 2루타, 3루타, 실책 등)
  tables[1] = away 타자 기록
    rows: [{row: [타순, 포지션, 선수명, 1회결과, &nbsp;, 2회결과, ..., 타수, 안타, 득점, 타점, 타율]}]
    - 이닝별 결과가 2컬럼씩 (결과+교체상태)
    - 마지막 5컬럼 = 타수, 안타, 득점, 타점, 타율
  tables[2] = home 타자 기록 (동일)
  tables[3] = away 투수 기록
    rows: [{row: [선수명, 이닝(선발/8.8), 승패(승/패/홀드/세이브/&nbsp;), 피안타, 타수, 피홈런, 삼진, 투구수, 볼, 피안타수, 사구, 실점, 자책, 폭투, 보크, ERA]}]
  tables[4] = home 투수 기록 (동일)
  
  경기 전이면 tables가 비어있거나 길이 0
```

## gameId 형식
- `G_ID` from GetKboGameList: `20250401LGKT0` (날짜+원정+홈+번호)
- `srId` (시리즈): 0=정규, 1=시범, 3=와일드카드, 4=준PO, 5=PO, 7=한국시리즈, 8=올스타, 9=국제대회

## 포지션명 매핑 (한글→영문)
```typescript
const POS_MAP: Record<string, string> = {
  "투수": "P", "포수": "C", "1루수": "1B", "2루수": "2B",
  "3루수": "3B", "유격수": "SS", "좌익수": "LF", "중견수": "CF",
  "우익수": "RF", "지명타자": "DH",
  // 교체 표기
  "타지": "DH", "타좌": "LF", "타우": "RF", "타중": "CF",
  "타1": "1B", "타2": "2B", "타3": "3B", "타유": "SS", "타포": "C",
  "주좌": "LF", "주우": "RF", "주중": "CF", "주1": "1B", "주2": "2B", "주3": "3B", "주유": "SS",
  "대타": "DH", "대주": "DH",
};
```

## 구현 항목

### 1. API Route: `/api/game-detail/route.ts`
- params: `gameId` (required), `seasonId` (optional, default current year)
- 3개 KBO API 병렬 호출 (Promise.all)
- srId: gameId에서 GetKboGameList의 SR_ID를 알아야 함 → 일단 기본값 사용하되, 쿼리파라미터로도 받기
- 파싱 로직: KBO 응답 → 정규화된 GameDetail 타입
- **null-safe**: 경기 전/취소/데이터 없음 시 각 필드 null 반환
- revalidate: 30 (라이브 시 더 짧게)
- 응답 타입:

```typescript
interface GameDetailResponse {
  gameId: string;
  status: "scheduled" | "live" | "final" | "cancelled"; // 삼순이 제안 반영
  meta: {
    stadium: string;
    crowd: string | null;
    startTime: string | null;
    endTime: string | null;
    duration: string | null;
  } | null;
  linescore: {
    away: { innings: (number | null)[]; R: number; H: number; E: number };
    home: { innings: (number | null)[]; R: number; H: number; E: number };
  } | null;
  lineup: {
    isToday: boolean; // LINEUP_CK
    away: LineupEntry[];
    home: LineupEntry[];
  } | null;
  boxScore: {
    awayBatters: BatterRecord[];
    homeBatters: BatterRecord[];
    awayPitchers: PitcherRecord[];
    homePitchers: PitcherRecord[];
  } | null;
}

interface LineupEntry {
  order: number;
  position: string; // 영문 (CF, SS, 1B, DH 등)
  positionKr: string; // 한글 원본
  name: string;
  war: number;
}

interface BatterRecord {
  order: number;
  position: string;
  name: string;
  atBats: number;
  hits: number;
  runs: number;
  rbi: number;
  avg: string;
}

interface PitcherRecord {
  name: string;
  inningsPitched: string; // "선발", "7.8" 등
  decision: string; // "승", "패", "홀드", "세이브", ""
  pitchCount: number;
  hits: number;
  strikeouts: number;
  walks: number;
  earnedRuns: number;
  era: string;
}
```

### 2. Custom Hook: `useGameDetail(gameId)`
- `/api/game-detail?gameId=xxx` 폴링 (경기 중 30초, 종료 후 중단)
- SWR 또는 간단한 useState+useEffect
- useLiveGame과 병합해서 사용

### 3. 컴포넌트 연결

#### LinescoreTable
- 현재: `innings: GameInning[]` prop + mock awayHits/homeHits/awayErrors/homeErrors 하드코딩
- 변경: gameDetail.linescore에서 실데이터 전달
- innings를 linescore.away.innings / home.innings에서 생성

#### FieldViewV2
- 현재: `defenders: LineupPlayer[]` prop → mock MOCK_LINEUP에서 전달
- 변경: gameDetail.lineup에서 수비중인 팀(이닝 초=홈팀 수비, 말=원정팀 수비) 라인업 전달
- position 매핑 (한글→영문)은 API route에서 처리

#### MatchupCard
- 현재: ERA/타율은 static JSON lookup, 오늘 기록은 하드코딩 ("72구", "2타수 1안타" 등)
- 변경: gameDetail.boxScore에서 현재 투수/타자의 오늘 기록 실데이터 전달
- 투구수, B/S/K/BB, 타수/안타/득점/홈런/볼넷 모두 실데이터

#### OnDeckBatters (FieldViewV2 내부)
- 현재: onDeckBatters prop은 mock
- 변경: 현재 타자의 타순 기준으로 lineup에서 다음 2~3명 계산

### 4. 경기 상세 페이지 (`games/[gameId]/page.tsx`)
- useGameDetail hook 추가
- 기존 mock 데이터(MOCK_GAME_STATE, MOCK_LINEUP, mock GameInning) → gameDetail 데이터로 교체
- useLiveGame (BSO/주자/투수/타자) + useGameDetail (라인스코어/라인업/박스스코어) 병합

## Fallback 전략
- API 호출 실패 → 해당 섹션 null, UI에서 스켈레톤 또는 "데이터 없음" 표시
- 경기 전 (라인스코어 없음) → LinescoreTable에 빈칸(-) 표시 (현재 동작 유지)
- 라인업 미발표 → "최근 라인업 기준" 표시 (lineup.isToday = false)
- 취소 경기 → 메타 정보만 표시

## 주의사항
- KBO API는 비공식 → User-Agent 헤더 포함
- 요청 빈도 제한 필요 (revalidate 30초 이상)
- srId는 gameId만으로 판단 어려움 → GetKboGameList 응답에서 SR_ID 확인 필요. 일단 쿼리파라미터로 받되, 기본값은 날짜 기반 추정
