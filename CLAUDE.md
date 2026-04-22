# 크보 에브리데이 — AI Coding Agent Instructions

## 프로젝트 개요
KBO 전 구단 팬 커뮤니티 플랫폼. Next.js 15 + Supabase + Tailwind.

## 중요: 스펙 문서를 먼저 읽을 것
모든 구현은 `specs/` 폴더의 스펙 문서를 기반으로 해야 함:
- `specs/constitution.md` — 전체 프로젝트 개요
- `specs/auth/spec.md` — 유저 시스템
- `specs/community/spec.md` — 게시판
- `specs/game-tracker/spec.md` — 실시간 경기 트래커
- `specs/stats/spec.md` — 스탯 인포그래픽
- `specs/news-feed/spec.md` — 뉴스 피드
- `specs/prediction/spec.md` — 승부예측
- `specs/design-system/spec.md` — 디자인 시스템
- `specs/plan.md` — 구현 계획 + 파일 구조

## 디자인 원칙
- 다크 모드 기본 (OLED 최적화)
- 글래스모피즘 (backdrop-blur, 반투명 카드)
- 다이나믹 팀 컬러 (팀별로 배경 그라데이션 전환)
- Pretendard 폰트
- 60fps 모션 (Framer Motion + GSAP)
- 모바일 퍼스트
- "이게 무료 앱이라고?" 수준의 퀄리티

## 코딩 원칙
- 정확성 > 영리함
- 최소 변경, 기존 패턴 따르기
- TypeScript strict
- React Server Components 적극 활용
- Optimistic UI + Skeleton UI

## Karpathy 4원칙 (LLM Coding Guidelines)

받아오는 변화 선언—즉각적 현재 수정·수행 기준:

### 1. Think Before Coding
**가정하지 마세요. 혼란을 숨기지 마세요. 트레이드오프를 드러내세요.**
- 구현 전 가정을 명시하고, 불확실하면 질문
- 해석이 여러 가지면 다 제시—조용히 고르지 말 것
- 더 간단한 접근이 있으면 반대 의견 제시
- 애매하면 멈추고, 어디가 혼란인지 말하고 질문

### 2. Simplicity First
**문제를 푸는 최소의 코드. 더 이상 안됨.**
- 요청받지 않은 기능 추가 금지
- 일회용 코드에 추상화 금지
- 요청 없는 "유연성/설정가능성" 금지
- 불가능한 시나리오의 에러 핸들링 금지
- 200줄 썬던 게 50줄로 줄일 수 있으면 재작성
- 체크: "시니어 엔지니어가 보면 오버컴플리케이티드라 할까?" 그렇다면 간단하게

### 3. Surgical Changes
**꼭 필요한 것만 건드리세요. 내가 만든 엉만 정리하세요.**
- 인접 코드/주석/포맷을 "개선" 금지
- 안 부서진 것 리팩토링 금지
- 내가 다르게 할 것이라도 기존 스타일 따르기
- 연관 없는 dead code 발견 시 **언급만하고 삭제는 하지 말 것**
- 내 변경으로 고아가 된 것만 정리 (import/variable/function)
- **테스트**: 모든 변경 줄이 사용자 요청과 직접 연결되나?

### 4. Goal-Driven Execution
**성공 기준을 정의하고 검증될 때까지 루프.**
- "검증 추가" → "잘못된 입력에 대한 테스트 작성 후 통과하게 하기"
- "버그 수정" → "버그 재현하는 테스트 작성 후 통과"
- "X 리팩토링" → "before/after 테스트 모두 통과"
- 멀티스텝 작업은 간략한 플랜 명시: `1. [Step] → verify: [check]`
- 강한 성공 기준이 있어야 독립적 루프 가능

**이 원칙이 살아있을 때:** diff에 불필요한 변경 감소 / 과복잡 때문의 재작성 감소 / 명확화 질문이 실수 이전에 나옹.

원본: [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills)
