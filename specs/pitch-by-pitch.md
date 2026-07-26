# Spec — Pitch-by-Pitch 투구 중계 (구종·구속·볼카운트·승부과정 펼쳐보기)

> Status: Slice 1 MERGED (#842) · Live Slice 승인/구현 중 (하린아빠 "굿. 이대로 진행" 2026-07-26)
> Origin: 건의함 "파도"(Android 1.0.15) 2번+4번 / 하린아빠 GO 2026-07-25
> Owner: 삼식이 (구현) · 삼순이 (리뷰 게이트)

## 1. Problem / Why

유저 건의:
- (2) 실시간 텍스트 중계에 **볼카운트·구종·구속** 표시 + **승부과정 펼쳐보기**(화살표)
- (4) 과거 기록에도 동일하게 **승부과정 펼쳐보기** + 안타→타점 연결

현재 우리 `game-relay` API는 네이버 relay payload를 매 fetch 하면서
`type:13/23`(타석 결과)·`type:14/24`(주루)만 파싱하고,
**투구 단위 데이터(`type:1`)를 통째로 버리고 있다.**

## 2. 데이터 소스 실측 (2026-07-25, 실경기 20260724WOHT0 검증)

네이버 relay `textOptions[].type===1` = 투구 1개. 필드:

| 필드 | 예시 | 의미 |
|---|---|---|
| `text` | `"3구 헛스윙"` | 투구 순번+결과 텍스트 |
| `pitchNum` | `3` | 타석 내 투구 번호 |
| `stuff` | `직구/투심/커브/슬라이더/스위퍼/체인지업/포크` | 구종(7종 실측) |
| `speed` | `"154"` | 구속(km/h) |
| `pitchResult` | `S/B/F/H/T/W` | 스트라이크/볼/파울/헛스윙/인플레이타격/유효볼 |
| `currentGameState` | `{strike,ball,out,base1,base2,base3,score...}` | 투구 시점 카운트·주자·스코어 스냅샷 |
| `currentPlayersInfo` | 투수·타자 월간/시즌/통산/상대전적 | 매 투구 동봉 |

→ **구속·구종·볼카운트·주자상황이 투구 단위로 전부 존재.** 신규 소스 불필요, 파싱만 추가.

## 3. 데이터 소스 추상화 (미래 대비)

`PitchDataProvider` 인터페이스로 소스 격리:
- 현재: `NaverRelayPitchProvider` (기존 relay payload 재사용, 신규 fetch 0)
- 미래: 스포츠투아이 계약 시 `Sports2iPitchProvider`로 어댑터 교체 → 화면/파싱 로직 재사용
- 네이버 스키마 변경 리스크는 provider 내부에 격리 + fail-safe(필드 없으면 pitch 목록만 비고 타석 결과는 유지)

## 4. Scope — 슬라이스 (얇은 수직 슬라이스, 빅뱅 금지)

### Slice 1 — 타석 승부과정 펼쳐보기 (실시간 + 과거 공용) [1차 배포 목표]
- 각 타석(PlayEvent) 행에 화살표 → 펼치면 그 타석 투구 시퀀스:
  `직구 154 · 볼` / `커브 125 · 스트라이크` / `직구 155 · 타격(2루타)`
- 마지막 투구는 타석 결과와 연결.
- 실시간 중계 탭 + 과거기록 탭 동일 컴포넌트.
- **데이터: 기존 relay payload 파싱만 추가** (API 라운드트립 0 증가).

### Slice 2 — 볼카운트 배지 + 구종 요약 [2차]
- 현재 타석 진행 중 볼카운트(S-B-O) 배지.
- 타석/경기 단위 구종 카운트 요약(예: `직구 12 · 슬라 8 · 포크 5`).

### Live Slice — 크관 현재 타석 자동 중계 [승인 범위]
- `parseInningRelays`가 terminal 전 최신 `type:8` 타자 + `type:1` 투구를
  `latestInning.currentAtBat`으로 반환한다. terminal 도달 시 완료 `plays`로 단일 이동.
- 크관 최신 이닝은 현재 타석을 기본 펼침하고, 새 공마다
  `N구 · 구종 · 구속 · 결과 · 투구 후 B/S`를 추가하며 최신 공을 accent 처리한다.
- 이전 완료 타석은 `결과 · 총 N구 · chevron` 접힘, 탭 시 같은 투구 목록을 펼친다.
- relay는 기존 라이브 5초 polling + 서버 4초 공유 캐시를 유지한다. 탭 hidden 시 요청을
  건너뛰고 visible 복귀 즉시 갱신하며, UI는 API의 마지막 성공 fetch 시각만 표시한다.
- relay 영역 `max-h-[40vh]`를 유지해 채팅 공간을 보존한다. 진행 중 데이터가 없으면
  기존 완료 타석/게임 이벤트 fallback을 그대로 사용한다.

### Slice 3 (선택) — 안타→타점 연결, 주자 진루 시각화 [백로그]
- 4번 건의의 "안타가 몇 타점" 표기. relay `type:14/24` + currentGameState.base 재사용.

## 5. Non-Goals (이번 범위 아님)
- 투구 궤적·스트라이크존 좌표 시각화 → 스포츠투아이 원천 계약 후 별도 트랙(현재 네이버는 좌표 미제공 확인 필요).
- 실시간 지연 개선(네이버 relay 자체 지연 수~십수초는 그대로 노출, 기대치 문구만).

## 6. 기술 설계

### 6.1 타입 (구현 확정 — `src/lib/game/pitch-provider.ts`)

⚠️ 구현 시 초기 초안(`pitchNum`/`result` code)에서 변경됨. 삼순 리뷰 실측
(종료 9경기 2,726구)에서 원문 `pitchResult` code 의미가 불안정(예: `H`가
헛스윙 아닌 인플레이 타격)해 **code 의존을 버리고 `text` 파생 `kind`** 로 교체:

```ts
export interface PitchDetail {
  num: number;        // 타석 내 투구 번호 (1부터)
  stuff: string;      // 구종. 미측정 시 빈 문자열
  speed: number;      // 구속 km/h. 미측정/누락 시 0
  resultText: string; // 사람이 읽는 결과 텍스트 ("볼"/"헛스윙"/"타격"/"파울")
  kind: "ball"|"strike"|"foul"|"inplay"|"other"; // 색상/아이콘용, text 파생(code 미신뢰)
  count?: { ball: number; strike: number; out: number }; // Slice 2 볼카운트 배지용
}
// PlayEvent 에 추가
export interface PlayEvent { ...; pitches?: PitchDetail[]; }
```

파싱 진입점은 네이버 어댑터 `parseNaverPitch(opt)` (소스 격리). `type:1` 외/빈
`text` 는 `null` 로 생략(fail-safe).

### 6.2 파싱
- `parseInningRelays`에서 `type:1` opt를 현재 타석(마지막 push된 play)의 `pitches[]`에 누적.
- 타석 경계: `type:13/23`(결과) 도달 시 해당 타석 pitches 확정.
- fail-safe: `stuff/speed` 없으면 `text`만으로 최소 표시, 없으면 pitches 생략.

### 6.3 UI
- `PlayByPlay.tsx` / `LiveStatsTab.tsx` 타석 행에 접이식(ChevronDown, framer-motion) — 기존 패턴 재사용.
- 구종·구속·결과 pill 렌더. 다크모드 토큰 준수.

## 7. Verification (Goal-Driven)
- [x] 어댑터 파싱 회귀 `qa:pitch-parser` 14/14: 타구/볼/파울/번트헛스윙(V)·code 오분류 방지·fail-safe
- [x] **production `parseInningRelays` 타석 경계 회귀 `qa:pitch-inning-parser` 11/11**: malformed terminal/terminal 부재/빈 batter 뒤 정상 타석에 앞 타석 투구 미오염 + 새 타석(type:8) fail-closed reset + 정상 attach 유지 (fix 제거 시 5개 실패로 회귀성 실증)
- [x] fail-safe: pitch 필드 없는 구형 경기는 pitches 생략·타석 결과 그대로 노출(T6/T7)
- [x] `qa:query-guard` 220/0/0 / tsc 0 / 대상 eslint 0
- [ ] End-User QA: 실기기에서 라이브 경기 타석 펼치기 → 투구 시퀀스 표시, 과거 경기도 동일 (머지·배포 후)
- [x] API 라운드트립 증가 0 (기존 relay payload 재사용, 신규 fetch 0)
- [x] 진행 중 타석 API/경계 회귀 18/18 + 크관 320/390px 현재 카드 intersection/새 공 자동 복귀 UI 회귀
- [x] hidden 중 live→final 전환 후 visible 복귀 relay fetch 회귀
- [x] terminal relay 뒤 stale `currentBatter` 미합성 + 새 type:8 0구 current card 유지 회귀

## 8. Rollout
Slice 1 구현 → 테스트 → 삼순 리뷰 게이트 → 하린아빠 머지 승인 → 배포 → End-User QA → 위키 반영.
Slice 2/3는 Slice 1 안정화 후 순차.
