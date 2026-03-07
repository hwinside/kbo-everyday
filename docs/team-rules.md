# Team Rules (운영 룰)

이 문서는 팀 운영/개발 프로세스에서 합의된 룰을 모아둡니다.

## git push 승인 룰

- **git push는 반드시 하린아빠의 승인을 받은 후 진행한다**
- 혼자 판단해서 push 금지, 삼순이 승인만으로도 불가
- 절차: 배포 계획을 #discussion에 공유 → **하린아빠 OK** → push
- 특히 프로덕션/핵심 플로우 변경 시 공유 필수 항목:
  1. 변경 요약
  2. 롤백 방법
  3. 영향 범위
- 긴급 hotfix도 예외 없음 (사후 보고 아닌 사전 승인)

## 릴리즈노트 작성 룰

- **배포 1회 = 릴리즈노트 1건**
- **저장 위치:** `docs/release-notes.md` (append-only)
- **기록 타이밍:** 배포 완료 후 **5분 내**
- **필수 포함:** Commit/Tag SHA
- **기록 담당:** 삼식이

### 릴리즈노트 템플릿

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
