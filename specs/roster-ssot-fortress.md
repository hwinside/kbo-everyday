# Roster SSOT Fortress — 선수가 사라질 수 없는 파이프라인

**Status**: DRAFT v0.2 (2026-04-20 21:00 KST, 삼순이 조건부 GO 3건 반영)

## Changelog
- v0.4 (2026-08-01): **고정 count 계약 폐기 → dynamic SSOT**. `EXPECTED_ROSTER_COUNT`/`EXPECTED_COUNT` 상수 3곳을 제거하고 shape·unique kboId·known team·팀별 하한·canary 계약으로 대체. 인원 급변 방어는 자동 크롤 workflow의 main 대비 Δ 가드 + `roster-size-change` ack가 전담. 배경: 고정 count가 로스터 1명 변동만으로 매일 새벽 자동 PR을 영구 머지 불가로 만들었다(카라스코 56103, 878→879 실제 발생).
- v0.3: 구현 실측치 반영 — static 실제 수 **769명** (772명 → 오염 3건 제거 → 769명). `EXPECTED_ROSTER_COUNT = 769` 확정. T6 선행 완료 (김명규 59378 / 신재인 59377 / 이정준 96153 삭제).
- v0.2: 삼순이 3가지 강화 조건 반영 — (A) CI 하한선 750 → **755 고정 무예외**, (B) backNo 공란 허용 대신 **의미 있는 상태값(enum)** 분리, core field null 완전 차단, (C) **Supabase 단독 선수 추가 금지 (Phase 1)** = "static only admission, supabase extension only" 원칙 확정
- v0.1: 초안
**Owner**: 삼식이 (CTO)
**Reviewer**: 삼순이 (CSO)
**Approver**: 하린아빠
**Target**: 48h 내 배포 (내일 오전 리뷰 → GO → 구현 반나절 → QA → 배포)

---

## 0. 배경 & 문제 정의

**지금까지 "선수 한 명씩 사라진다"의 재발 원인**:

- static JSON (`src/lib/constants/players-roster.json`, 인원은 시즌 중 변동) = 안정 기반
- Supabase `players_roster` 테이블 (135명 subset) = 최신 외국인/신인 반영용
- `/api/roster`의 merge는 **static base → supabase override (전체 레코드 통째 교체)**

**→ Supabase 레코드에 `back_no=""` (공란)이 있으면, static에 존재하던 정상 등번호가 **통째로 덮여 사라짐**. 135명이 partial subset이므로 core field(등번호, 포지션, 이름)를 **부분 공란**으로 갖고 있으면 그대로 서비스에 노출.

**오늘 P0 사건**: 원태인(삼성) `#18` static에만 있음 → static 값 노출 OK. 그러나 구자욱/김재윤/김지찬/후라도 등 145명은 Supabase에 있으면서 등번호 공란 → 공란 노출.

**근본 원인 = 데이터가 아니라 "덮어쓰기 규칙"**.

---

## 1. SSOT 확정

### 1.1 결정

- **`src/lib/constants/players-roster.json` = roster SSOT** (단일 진실 소스. 인원은 콜업·트레이드로 상시 변하므로 어느 코드에도 고정하지 않는다 / v0.4)
- **Supabase `players_roster` 테이블 = 확장/오버레이 전용** (core field 보호)
- **원칙 (v0.2 확정)**: *Static-only roster admission, Supabase extension-only*. 신규 선수(신인/외국인 영입)는 **반드시 static JSON에 PR로 먼저 반영**된 후에만 서비스에 노출. Supabase에 단독으로 존재하는 선수는 `/api/roster` 응답에서 **완전 배제**.

### 1.2 Core Field (SSOT 보호 대상)

다음 필드는 **static JSON이 절대적 우선**, Supabase가 값을 갖고 있어도 **override 금지**:

- `kboId` (식별자)
- `name` (정식 표기)
- `team`, `teamId` (소속)
- `position`
- `backNo` (등번호)

### 1.3 Extension Field (Supabase 우선 OK)

- `photo_url`, `height`, `weight`, `birth_date`, `debut_year`, `career_stats_ref` 등 **부가 메타데이터**만 Supabase가 최신 우선.
- 없으면 static 대체 or null 반환.

### 1.4 backNo 상태값 (v0.2 추가)

- 공란(`""`)/null **금지**. 모든 레코드는 아래 3가지 중 하나:
  - 실제 등번호 문자열 (예: `"18"`, `"00"`) — 정상
  - `"-"` — 미배정 (신인 드래프트 직후 등, 공식 상태)
  - `"?"` — 확인 필요 (임시 상태, CI warning이지만 block 아님 → 별도 이슈 트래킹)
- 서비스 렌더는 `"-"`/`"?"`를 `"미정"`으로 표시.
- CI 가드 §3.1은 **정규식 검증** (`^(\d{1,3}|-|\?)$`), 이 외 값은 FAIL.

---

## 2. `/api/roster` merge rule 재정의

### 2.1 Before (현재, 위험)

```ts
const merged = new Map();
for (const p of staticPlayers) merged.set(p.kboId, p);       // base
for (const p of supabasePlayers) merged.set(p.kboId, p);     // 통째 override ← 사고 지점
```

### 2.2 After (안전)

```ts
// 1) static을 base로 세팅 (core field 완전성 보장)
const merged = new Map<string, RosterPlayer>();
for (const p of staticPlayers) merged.set(p.kboId, p);

// 2) Supabase는 extension field만 덮어씀 (core field 보호)
//    v0.2: Supabase 단독 kboId는 무조건 skip (static only admission)
for (const sb of supabasePlayers) {
  const base = merged.get(sb.kboId);
  if (!base) {
    // static에 없는 kboId = Phase 1에서는 서비스 노출 금지
    // 신규 선수는 static JSON PR로 먼저 반영되어야 함
    continue;
  }
  // 기존 선수: extension field만 갱신, core는 static 유지
  merged.set(sb.kboId, {
    ...base,                                     // core field 보호 (kboId/name/team/teamId/position/backNo)
    photoUrl: sb.photoUrl ?? base.photoUrl,     // extension only
    // ... 기타 extension only
  });
}
```

**핵심**: *Supabase가 core field를 override할 수 없음*. Supabase가 공란이든 틀렸든, static이 방패.
**v0.2 추가 잠금**: *Supabase 단독 추가도 불가*. 신규 선수는 반드시 static JSON PR 경유.

---

## 3. 재발 방지 3중 안전망

### 3.1 CI 가드 (Pre-merge, GitHub Actions)

`scripts/validate-roster.ts` 신설. PR마다 자동 실행:

- [x] **선수 수 계약 (v0.4 개정)**: validator는 고정 count를 들지 않는다. 빈 배열만 FAIL이며, 인원 급변은 자동 크롤 workflow가 **main 대비 |Δ| > 10** 이면 자동머지를 보류하고 `roster-size-change` ack를 요구하는 방식으로 막는다. [구현: `scripts/validate-roster.mjs`, `.github/workflows/update-roster-stats.yml`]
- [x] **파생 산출물 정합 (v0.4 신규)**: `data/baseball-qa/source-inventory.json`의 선수 집합이 roster SSOT와 exact 일치해야 한다(개수가 아니라 집합). 자동 크롤은 inventory-only로만 재생성하며, 리뷰·머지된 bootstrap migration은 고정 SHA-256으로 불변 잠금. [구현: `scripts/ci/sync-roster-derived-artifacts.mjs`, 회귀 `scripts/qa/roster-derived-sync-smoke.mjs`]
- [ ] **kboId 중복 검사**: 동일 kboId 2회 이상 출현 시 FAIL
- [ ] **kboId 공란/null 검사**: 빈 문자열/null/undefined 있으면 FAIL
- [ ] **core field null 검사 (v0.2 강화)**: `name`, `team`, `teamId`, `position`, `backNo` 중 1개라도 null/undefined/빈 문자열이면 **무조건 FAIL, 예외 없음**
- [ ] **backNo 상태값 검증 (v0.2 신규)**: `^(\d{1,3}|-|\?)$` 정규식 매치해야 함. 공란/undefined/기타 FAIL
- [ ] **개행문자/제어문자 검사**: `name`에 `\n`, `\r`, `\t` 포함되면 FAIL (김명규/신재인 NC 사고 방지)
- [ ] **팀별 선수 수 검증**: 각 팀 30명 이상 (비정상 누락 탐지)

PR에 `roster: Validation Failed` 체크 뜨면 머지 차단.

### 3.2 Prod 런타임 모니터

- [x] `/api/health/roster` 신설 (v0.4 개정): 고정 count 비교를 빼고 **행 shape(kboId/name/known team) 불량·kboId 중복·팀당 <30·canary 5명 누락** 시 **HTTP 503 + `issues[]` 반환**. heartbeat에서 1시간에 1회 폴링 → 503 시 Slack #cs 알림
- `/api/roster`: 고정 count 경고 로그는 v0.4에서 제거(정상 변동마다 오알람). 이상 탐지는 `/api/health/roster`의 shape/중복/하한/canary 계약이 담당
- `api/cron/roster` (auto-crawl) 실행 후 **DB 레코드 수가 전회 대비 -5% 초과 감소하면 rollback + 알림**
- 매일 09:00 KST heartbeat 체크에 "`/api/roster` 응답 선수 수" 자동 점검 추가

### 3.3 Auto-crawl PR 워크플로우

- 기존: crawler가 자동 PR 생성 → 사람 리뷰 → merge
- 변경: **PR 머지 시 CI 가드(3.1) 필수 통과**. 한 명이라도 사라지면 자동 FAIL.
- crawler 자체가 **기존 선수 삭제하려면 명시적 플래그** 필요 (`--allow-removal`). 디폴트는 append/update만.

---

## 4. One-shot 백필 (145명 등번호)

- `scripts/backfill-roster-backno.ts`로 Supabase `players_roster` 145명 등번호 채우기
- 근거 데이터: KBO 공식 사이트 크롤링 + static JSON 참조
- **이 백필은 §2 merge rule 배포 *후* 실행** (그래야 배포 중 이탈 없음)

---

## 5. 구현 Task 분해

**우선순위 & ETA (하린아빠 GO 기준)**:

| # | Task | 예상 | 의존 |
|---|------|------|------|
| T1 | `/api/roster` merge rule 재작성 (§2.2) | 1h | - |
| T2 | `scripts/validate-roster.ts` + GitHub Actions (§3.1) | 2h | - |
| T3 | Prod 런타임 모니터 (§3.2) | 1h | - |
| T4 | auto-crawl PR 가드 (§3.3) | 1h | T2 |
| T5 | 145명 등번호 백필 (§4) | 1h (데이터 크롤링) | T1 배포 후 |
| T6 | 이름 개행/유령ID 3건 정리 | 30m | T2 |
| T7 | 삼순이 QA + postmortem 위키 | 1h | T1~T6 |

**총 작업**: ~7.5h (반나절)

---

## 6. 완료 기준 (DoD)

- [x] (결정) static JSON = SSOT
- [ ] `/api/roster` merge rule이 core field를 Supabase override로부터 보호
- [ ] CI 가드 PR 차단 동작 확인 (의도적으로 선수 1명 삭제 PR 테스트)
- [ ] Prod 모니터 알림 시험 (임계치 조작 테스트)
- [ ] 145명 등번호 공란 0명
- [ ] 삼순이 QA: 원태인/구자욱/김재윤/김지찬/후라도 5명 등번호 검색 PASS
- [ ] 위키 `wiki/pages/크보팬/postmortem-roster-ssot-fortress.md` 작성
- [ ] `memory/2026-04-20.md` 기록

---

## 7. Open Questions

1. ~~*backNo 공란 허용 예외*~~ → **해결 (v0.2)**: §1.4에 상태값 enum(`\d+`/`-`/`?`)으로 고정, 공란 금지.
2. *Supabase 테이블 스키마*: 현재 135명이 partial subset. Phase 2에서 Supabase `players_roster`에 `kboId FK → static` 강제. Phase 1은 런타임 merge rule만으로 충분.
3. *크롤러 소유권 (재확인 필요)*: 현재 `/api/cron/roster`가 KBO 공식 사이트 크롤링 → Supabase에 쓰는 것으로 추정. **v0.2 원칙상 크롤러는 static JSON에 PR로 쓰는 방식으로 전환 필요** (Phase 1.5로 분리, T4에 포함).

---

## 8. 릴리즈 순서

1. 스펙 리뷰 → 하린아빠 GO
2. T1, T2, T3 구현 (PR 1개로 번들)
3. 삼순이 코드리뷰 → GO/NO-GO
4. 하린아빠 push 승인 → 배포
5. T4 (crawler 가드) → 별도 PR
6. T5 (145명 백필) → 별도 스크립트 실행
7. T6 → T7 (QA + postmortem)

---

**삼식이 서명**: 2026-04-20 21:00 KST
