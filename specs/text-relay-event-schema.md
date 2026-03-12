# 문자중계 표준 이벤트 스키마

> 작성: 2026-03-13
> 목적: 크보팬 실시간 문자중계 기능의 데이터 모델 정의

---

## 1. 현실 파악 (데이터 소스)

### ✅ 사용 가능한 KBO API (JSON)
| API | 데이터 | 갱신 |
|-----|--------|------|
| `GetKboGameList` | BSO, 이닝, 주자, 현재 투수/타자 | 투구 단위 (~15초 폴링) |
| `GetScoreBoard` | 이닝별 점수, R/H/E | 반이닝 단위 |
| `GetBoxScore` | 타자/투수 당일 기록 | 타석/투구 단위 |
| `GetLineUpAnalysis` | 선발 라인업 + 포지션 | 경기 전 1회 |

### ❌ 없는 것
| 데이터 | 상황 |
|--------|------|
| **투구별 문자중계 텍스트** | KBO 사이트는 ASP.NET PostBack 서버 렌더링. REST 엔드포인트 없음 |
| **투구 속도/구종** | KBO 공식 API에 미포함 |
| **투구별 결과 상세** | "볼", "스트라이크(헛스윙)", "파울", "안타(좌전)" 등의 텍스트 |

### 🔧 대안 확보 방법
1. **Mac mini 크롤링**: ScoreBoard.aspx를 Playwright로 폴링 → HTML 파싱 → JSON 변환 → static 파일 업데이트
2. **네이버 스포츠 API**: 별도 조사 필요 (제휴 문의 대상)
3. **자체 생성**: 기존 API 데이터 변화를 감지해 이벤트 자동 생성 (정확도 낮지만 즉시 가능)

---

## 2. 이벤트 스키마 정의

### 2.1 GameEvent (단일 이벤트)

```typescript
interface GameEvent {
  /** 고유 ID (gameId + inning + sequence) */
  id: string;
  
  /** 경기 ID */
  gameId: string;
  
  /** 이벤트 발생 시각 (ISO 8601) */
  timestamp: string;
  
  /** 이닝 정보 */
  inning: number;
  isTop: boolean;  // true=초, false=말
  
  /** 이벤트 타입 */
  type: GameEventType;
  
  /** 이벤트 상세 (타입별 다름) */
  detail: EventDetail;
  
  /** 문자중계 텍스트 (사용자에게 보여줄 한글 문장) */
  text: string;
  
  /** 이벤트 시점의 스냅샷 */
  snapshot: GameSnapshot;
}

type GameEventType =
  // 투구 관련
  | "pitch_ball"        // 볼
  | "pitch_strike"      // 스트라이크 (헛스윙/콜/파울)
  | "pitch_foul"        // 파울
  | "pitch_in_play"     // 인플레이 (타구 발생)
  
  // 타석 결과
  | "at_bat_hit"        // 안타 (1루타/2루타/3루타)
  | "at_bat_homerun"    // 홈런
  | "at_bat_out"        // 아웃 (플라이/그라운드/라인드라이브)
  | "at_bat_error"      // 실책 출루
  | "at_bat_walk"       // 볼넷 (4구)
  | "at_bat_hbp"        // 사구
  | "at_bat_strikeout"  // 삼진 (헛스윙/루킹)
  | "at_bat_sacrifice"  // 희생번트/희생플라이
  | "at_bat_fc"         // 야수선택
  | "at_bat_dp"         // 병살타
  
  // 주루
  | "stolen_base"       // 도루
  | "caught_stealing"   // 도루실패
  | "runner_advance"    // 주자 진루 (야수선택/패스트볼 등)
  | "runner_out"        // 주자 아웃
  | "run_scored"        // 득점
  
  // 경기 흐름
  | "inning_start"      // 이닝 시작
  | "inning_end"        // 이닝 종료 (3아웃)
  | "pitching_change"   // 투수 교체
  | "pinch_hitter"      // 대타
  | "pinch_runner"      // 대주자
  | "defensive_change"  // 수비 교체
  | "game_start"        // 경기 시작
  | "game_end"          // 경기 종료
  | "game_delayed"      // 우천/기타 중단
  | "game_resumed"      // 경기 재개
  
  // 특수
  | "challenge"         // 비디오 판독
  | "mound_visit"       // 마운드 방문
  | "info";             // 기타 정보성 텍스트

/** 타입별 상세 정보 */
type EventDetail = 
  | PitchDetail
  | AtBatResultDetail
  | RunnerDetail
  | SubstitutionDetail
  | InningDetail
  | InfoDetail;

interface PitchDetail {
  pitcher: string;
  batter: string;
  pitchNumber?: number;   // 이 타석 N번째 투구
  speed?: number;         // km/h (확보 가능할 때만)
  pitchType?: string;     // 구종 (확보 가능할 때만)
  strikeType?: "swinging" | "called" | "foul";
}

interface AtBatResultDetail {
  pitcher: string;
  batter: string;
  direction?: string;     // "좌전", "중견", "우월" 등
  rbi?: number;           // 타점
  runsScored?: string[];  // 득점한 주자 이름들
}

interface RunnerDetail {
  runner: string;
  fromBase: 1 | 2 | 3;
  toBase: 1 | 2 | 3 | 4;   // 4 = 홈
}

interface SubstitutionDetail {
  playerIn: string;
  playerOut: string;
  position?: string;
  team: string;
}

interface InningDetail {
  inning: number;
  isTop: boolean;
}

interface InfoDetail {
  message: string;
}
```

### 2.2 GameSnapshot (이벤트 시점의 경기 상태)

```typescript
interface GameSnapshot {
  /** 점수 */
  awayScore: number;
  homeScore: number;
  
  /** 카운트 */
  balls: number;
  strikes: number;
  outs: number;
  
  /** 주자 */
  runners: {
    first: string | null;   // 주자 이름 또는 null
    second: string | null;
    third: string | null;
  };
  
  /** 현재 대결 */
  pitcher: string;
  batter: string;
  
  /** 이닝별 점수 (라인스코어) */
  linescore?: {
    away: (number | null)[];
    home: (number | null)[];
  };
}
```

### 2.3 GameEventStream (경기 전체 이벤트 묶음)

```typescript
interface GameEventStream {
  gameId: string;
  date: string;            // YYYYMMDD
  awayTeam: string;
  homeTeam: string;
  stadium: string;
  status: "scheduled" | "live" | "final" | "cancelled";
  
  /** 이벤트 배열 (시간순 정렬) */
  events: GameEvent[];
  
  /** 마지막 업데이트 시각 */
  lastUpdated: string;
  
  /** 현재 상태 스냅샷 (최신) */
  currentState: GameSnapshot;
}
```

---

## 3. Phase 1 구현: API 기반 자동 이벤트 생성

KBO 전용 문자중계 API가 없으므로, **기존 API 폴링 + 변화 감지**로 이벤트를 자동 생성하는 전략.

### 3.1 변화 감지 로직

```
GetKboGameList 폴링 (15초 간격)
  ↓ 이전 상태와 diff
  ↓
[아웃 카운트 변화] → at_bat_out / at_bat_strikeout 추론
[점수 변화] → run_scored + at_bat_hit/homerun 추론  
[이닝 변화] → inning_end + inning_start
[투수/타자 변화] → pitching_change / 새 타석 시작
[주자 변화] → runner_advance / stolen_base 추론
[BSO 리셋] → 새 타석 시작 감지

GetBoxScore 폴링 (30초 간격)  
  ↓ 이전 상태와 diff
  ↓  
[타자 행 추가/변경] → 상세 결과 보강 (안타/삼진/볼넷 구분)
[투수 행 추가/변경] → 투수 교체 감지 + 투구수/피안타 업데이트
```

### 3.2 생성 가능한 이벤트 (Phase 1)

| 이벤트 타입 | 감지 방법 | 정확도 |
|------------|-----------|--------|
| `inning_start/end` | 이닝 번호 변화 | ✅ 정확 |
| `game_start/end` | GAME_STATE_SC 변화 | ✅ 정확 |
| `run_scored` | 점수 변화 | ✅ 정확 |
| `at_bat_strikeout` | BoxScore 삼진 수 증가 | ✅ 정확 |
| `at_bat_walk` | BoxScore 볼넷 수 증가 | ✅ 정확 |
| `at_bat_hit` | BoxScore 안타 수 증가 | ✅ 정확 |
| `at_bat_homerun` | BoxScore HR 수 증가 | ✅ 정확 |
| `pitching_change` | 투수 이름 변화 | ✅ 정확 |
| `at_bat_out` | 아웃카운트 증가 (삼진/볼넷 아닐 때) | ⚠️ 추론 |
| `stolen_base` | 주자 위치 변화 (아웃/BSO 변화 없이) | ⚠️ 추론 |
| `pitch_ball/strike` | BSO 카운트 변화 | ⚠️ 15초 지연 |

### 3.3 한계 & Phase 2 개선

| 한계 | Phase 2 해결 |
|------|-------------|
| 투구별 텍스트 없음 | ScoreBoard.aspx 크롤링 or 네이버 API |
| 구종/구속 없음 | 외부 데이터 연동 필요 |
| 15초 지연 | 폴링 간격 단축 (리스크: 차단) |
| 방향(좌전/우월) 없음 | 문자중계 텍스트 크롤링 |

---

## 4. 파일 구조 (제안)

```
src/
  types/
    game-events.ts          # 위 타입 정의
  lib/
    event-generator.ts      # API diff → GameEvent 변환
    event-text-builder.ts   # GameEvent → 한글 텍스트 생성
  app/
    api/
      game-events/
        route.ts            # GET /api/game-events?gameId=xxx
  components/
    game/
      TextRelayFeed.tsx     # 이벤트 피드 UI (채팅형)
      TextRelayEvent.tsx    # 단일 이벤트 렌더링
```

---

## 5. UI 참고 (문자중계 피드)

```
┌─────────────────────────────────────────┐
│  1회초                                   │
├─────────────────────────────────────────┤
│  🟢 경기 시작                            │
│  ⚾ 홍창기 vs 고영표                      │
│  ● 1B 볼 → B1-S0                        │
│  ● 2S 스트라이크 → B1-S1                  │
│  ● 3S 헛스윙 삼진 — 1아웃                 │
│  ⚾ 오스틴 vs 고영표                      │
│  🔵 좌전 안타! → 1루                      │
│  ⚾ 김현수 vs 고영표                      │
│  🔴 중견수 플라이 — 2아웃                  │
│  ...                                     │
├─────────────────────────────────────────┤
│  1회말                                   │
│  ...                                     │
└─────────────────────────────────────────┘
```

---

## 6. 결론 & 다음 스텝

**Phase 1 (지금 가능):**
1. `types/game-events.ts` — 타입 정의
2. `event-generator.ts` — GetKboGameList + GetBoxScore diff → 이벤트 자동 생성
3. `TextRelayFeed.tsx` — 이벤트 피드 UI
4. 정확도: 주요 이벤트(이닝/득점/안타/삼진/볼넷/교체) 90%+

**Phase 2 (크롤링/제휴 후):**
1. ScoreBoard.aspx Playwright 크롤링 → 투구별 상세 텍스트
2. 구종/구속 데이터 연동
3. 네이버 스포츠 API 제휴 (메일 드래프트 진행 중)

**제안: Phase 1으로 시범경기 기간에 테스트하고, 정규시즌 전에 Phase 2 크롤링 붙이기**
