/* ===== 하이라이트 릴 — 실제 YouTube 영상 ===== */

export interface Highlight {
  id: string;
  teamId: number | null;
  title: string;
  youtubeId: string;
  thumbnail: string;
  channel: string;
  timeAgo: string;
  type: "highlight" | "interview" | "analysis" | "vlog";
}

export const HIGHLIGHTS: Highlight[] = [
  { id: "h1", teamId: 1, title: "8월 15일 LG vs 한화 [2024 정규시즌 하이라이트]", youtubeId: "rOOwMC-bFec", thumbnail: "https://i.ytimg.com/vi/rOOwMC-bFec/hqdefault.jpg", channel: "LGTWINSTV", timeAgo: "6개월 전", type: "highlight" },
  { id: "h2", teamId: 6, title: "기아 SSG 하이라이트 : 2024 최악의 오심 끝내기 득점 삭제!", youtubeId: "f15KFGWpf4k", thumbnail: "https://i.ytimg.com/vi/f15KFGWpf4k/hqdefault.jpg", channel: "1분크보", timeAgo: "5개월 전", type: "highlight" },
  { id: "h3", teamId: null, title: "[2025 RECAP] 크보를 빛낸 명장면 모음zip", youtubeId: "Y5XDaz8QOgQ", thumbnail: "https://i.ytimg.com/vi/Y5XDaz8QOgQ/hqdefault.jpg", channel: "TVING SPORTS", timeAgo: "1개월 전", type: "highlight" },
  { id: "h4", teamId: 4, title: "18안타 13득점🔥 타선 대폭발! 연습경기 vs 라쿠텐", youtubeId: "_ZWSagWQa1o", thumbnail: "https://i.ytimg.com/vi/_ZWSagWQa1o/hqdefault.jpg", channel: "SSG랜더스", timeAgo: "1일 전", type: "highlight" },
  { id: "h5", teamId: 5, title: "[GAME HIGHLIGHT] 9월 30일 KT vs NC", youtubeId: "JIaJeyX5DEo", thumbnail: "https://i.ytimg.com/vi/JIaJeyX5DEo/hqdefault.jpg", channel: "NC 다이노스", timeAgo: "5개월 전", type: "highlight" },
  { id: "h6", teamId: 3, title: "[삼성 vs KT] 2025 KBO 리그 하이라이트", youtubeId: "p8fmnpT__Lo", thumbnail: "https://i.ytimg.com/vi/p8fmnpT__Lo/hqdefault.jpg", channel: "TVING SPORTS", timeAgo: "2주 전", type: "highlight" },
  { id: "h7", teamId: 7, title: "[롯데 vs SSG] 2025 KBO 리그 하이라이트", youtubeId: "wyDXwzlxX1I", thumbnail: "https://i.ytimg.com/vi/wyDXwzlxX1I/hqdefault.jpg", channel: "TVING SPORTS", timeAgo: "1주 전", type: "highlight" },
  { id: "h8", teamId: 8, title: "삼성 라이온즈 vs 요미우리 자이언츠 연습경기 하이라이트", youtubeId: "AKQsWFv6jyc", thumbnail: "https://i.ytimg.com/vi/AKQsWFv6jyc/hqdefault.jpg", channel: "LionsTV", timeAgo: "1일 전", type: "highlight" },
  { id: "h9", teamId: 9, title: "[KS 3차전] LG VS 한화 한국시리즈 하이라이트", youtubeId: "4bhg9omu6kQ", thumbnail: "https://i.ytimg.com/vi/4bhg9omu6kQ/hqdefault.jpg", channel: "Eagles TV", timeAgo: "5개월 전", type: "highlight" },
  { id: "h10", teamId: 9, title: "[PO 5차전] 삼성 VS 한화 — 한국시리즈 진출!", youtubeId: "R7Cp_BpwROo", thumbnail: "https://i.ytimg.com/vi/R7Cp_BpwROo/hqdefault.jpg", channel: "Eagles TV", timeAgo: "5개월 전", type: "highlight" },
  { id: "h11", teamId: 10, title: "키움 타선 7득점 빅이닝! 쉴 틈 없는 타선 폭발", youtubeId: "D9GYVBoLhJg", thumbnail: "https://i.ytimg.com/vi/D9GYVBoLhJg/hqdefault.jpg", channel: "KBO", timeAgo: "6개월 전", type: "highlight" },
  { id: "h12", teamId: null, title: "KBO 역대 최고의 홈런 모음 (1982~2023)", youtubeId: "Pjsc96S4WWo", thumbnail: "https://i.ytimg.com/vi/Pjsc96S4WWo/hqdefault.jpg", channel: "KABY BASEBALL", timeAgo: "1년 전", type: "highlight" },
  { id: "h13", teamId: null, title: "[2025 KBO결산] 소름 돋는 최고의 호수비 TOP10", youtubeId: "6fP5Q9a_db8", thumbnail: "https://i.ytimg.com/vi/6fP5Q9a_db8/hqdefault.jpg", channel: "스탐", timeAgo: "2개월 전", type: "analysis" },
  { id: "h14", teamId: 2, title: "두산 선수들 격려와 동시에 기강잡는 구단주의 한마디", youtubeId: "pTDqGakettc", thumbnail: "https://i.ytimg.com/vi/pTDqGakettc/hqdefault.jpg", channel: "볼맛나네", timeAgo: "3개월 전", type: "interview" },
  { id: "h15", teamId: 7, title: "[KT vs 롯데] 2025 KBO 리그 하이라이트", youtubeId: "MIlt61ZmAx4", thumbnail: "https://i.ytimg.com/vi/MIlt61ZmAx4/hqdefault.jpg", channel: "TVING SPORTS", timeAgo: "3일 전", type: "highlight" },
];

export function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}만`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}천`;
  return n.toLocaleString();
}

export const HIGHLIGHT_TYPES = {
  highlight: { label: "하이라이트", emoji: "🔥" },
  interview: { label: "인터뷰", emoji: "🎤" },
  analysis: { label: "분석", emoji: "📊" },
  vlog: { label: "브이로그", emoji: "📹" },
};
