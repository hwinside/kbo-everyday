# 밈 에디터 v2 — 선수 식별자 통합 + player_tags kboId 저장

## 목표
1. PlayerTagger가 `players-roster.json`(kboId 기반)을 소스로 사용 (내부 목업 id 제거)
2. DB `player_tags`에 kboId를 저장하여 동명이인 완전 대응
3. 기존 name-only 데이터 하위 호환

## 변경 사항

### 1. PlayerTag 인터페이스 변경
```ts
// Before
interface PlayerTag {
  id: number;      // 내부 목업 id (101, 102...)
  name: string;
  teamId: number;
}

// After
interface PlayerTag {
  kboId: string;   // KBO 공식 id ("69100", "74540"...)
  name: string;
  teamId: number;
}
```

### 2. PlayerTagger 데이터 소스 전환
- **Before:** `import * as playerData from "@/lib/constants/players"` (목업 데이터)
- **After:** `import PLAYERS_ROSTER from "@/lib/constants/players-roster.json"` (684명 실 데이터)
- `getPlayersForTeam()` → roster에서 teamId로 필터
- 즐겨찾기 매칭도 kboId 기반으로 전환

### 3. player_tags DB 저장 포맷 변경
- **Before:** `player_tags: ["김현수", "구본혁"]` (이름만)
- **After:** `player_tags: ["69100:구본혁", "74540:김현수(LG)"]` (kboId:표시명)
- 포맷: `{kboId}:{displayName}`
- 파싱 유틸: `parsePlayerTag(tag) → { kboId, displayName }`

### 4. PhotoFeed 렌더링 변경
- `findPlayerByName(name)` 제거
- `parsePlayerTag(tag)` → kboId로 직접 링크 생성
- 하위 호환: `:` 없는 기존 태그는 name으로 fallback

### 5. WritePhotoPost 변경
- `selectedPlayers.map(p => p.name)` → `selectedPlayers.map(p => \`${p.kboId}:${p.name}\`)`
- `handlePlayerToggle`: `p.id` 비교 → `p.kboId` 비교
- `defaultPlayerTag` prop 타입 업데이트

### 6. 연관 파일 업데이트
- `PlayerPickerSheet.tsx`: kboId 기반으로 전환 (사용하는 곳 확인)
- `community/players/page.tsx`: defaultPlayerTag 전달 시 kboId 포함

## 영향 범위
| 파일 | 변경 |
|------|------|
| `src/components/community/PlayerTagger.tsx` | 데이터 소스 + 인터페이스 |
| `src/components/community/WritePhotoPost.tsx` | PlayerTag 타입 + 저장 포맷 |
| `src/components/community/PhotoFeed.tsx` | 렌더링 파싱 |
| `src/components/community/PlayerPickerSheet.tsx` | kboId 전환 (있다면) |
| `src/app/(main)/community/players/page.tsx` | defaultPlayerTag |
| `src/lib/utils/player-tags.ts` | 신규: 파싱 유틸 |

## 하위 호환
- 기존 DB 데이터(`["김현수"]`)는 마이그레이션 없이 읽기 호환
- `parsePlayerTag("김현수")` → `{ kboId: null, displayName: "김현수" }` → name fallback 유지
- 신규 저장분부터 kboId 포함

## 테스트
- 동명이인 선수(김현수 LG/KT) 태그 → 각각 올바른 선수 페이지로 링크
- 기존 name-only 태그 포스트 → 정상 렌더링 (fallback)
- 즐겨찾기 선수 → PlayerTagger에 정상 표시
