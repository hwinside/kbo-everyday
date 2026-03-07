# Release Notes (append-only)

> Rule: 1 deploy = 1 entry (append-only)

---

## Template

Release: `YYYY-MM-DD HH:mm KST`
Env: prod (`keubo.fan`)
Commit/Tag: `abcdef1` (필수)
Owner: 삼식이
Links: PR/이슈/슬랙스레드(선택)

Summary (3줄 이내)

- ...

Changes (구체)

- [Fix] ...
- [UI/UX] ...
- [Perf] ...
- [Ops] ...

User Impact / Notes

- 영향 범위(예: iOS PWA, 커뮤니티>티켓)
- 사용자가 체감하는 변화/주의사항

QA Checklist (체크된 것만)

- [ ] iOS PWA
- [ ] Mobile Safari/Chrome
- [ ] 주요 플로우 2~3개

Rollback

- 롤백 기준(증상): ...
- 롤백 커밋/방법: ...

---

## Releases

Release: `2026-03-07 19:29 KST`
Env: prod (`keubo.fan`)
Commit/Tag: `772aa02`
Owner: 삼식이
Links: (slack) https://keubofan.slack.com/archives/C0AKRDUGC2U/p1772875881024139

Summary (3줄 이내)

- 커뮤니티 > 티켓 탭 첫 진입 UX 개선(배너 슬림/필터 진입점)
- 티켓 FAB 스크롤 토글 제거(항상 고정 노출)

Changes (구체)

- [UI/UX] 티켓 안내 배너 2개 → 1개 통합 + “정가 이하 원칙” 접기/펼치기
- [UI/UX] 팀 필터 영역에 라벨 추가 + `필터` 바텀시트(구장 선택) 제공
- [Fix] 팀 칩 영역 가로 오버플로우로 화면 밀리던 현상 완화(칩 row overflow 처리)
- [UI/UX] FAB 위치 보정(하단 네비 가림 최소화) + 스크롤 hide/show 제거

User Impact / Notes

- 커뮤니티 > 티켓 탭 첫 진입에서 리스트가 더 빨리 보이고, 필터 진입이 명확해짐
- 구장 CTA로 진입 시 `/community/tickets?venue=...` URL로 필터 유지

QA Checklist (체크된 것만)

- [ ] iOS PWA
- [x] Desktop Chrome (sanity)
- [ ] Mobile Safari/Chrome
- [ ] 주요 플로우 2~3개

Rollback

- 롤백 기준(증상): 티켓 탭 첫 진입에서 필터 시트/배너 동작 오류, 레이아웃 깨짐
- 롤백 커밋/방법: `git revert 772aa02` (필요 시 직전 릴리즈로 단계적 revert)

---


