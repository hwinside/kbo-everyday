# Team Rules (운영 룰)

이 문서는 팀 운영/개발 프로세스에서 합의된 룰을 모아둡니다.

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
