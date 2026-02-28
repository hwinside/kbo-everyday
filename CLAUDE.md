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
