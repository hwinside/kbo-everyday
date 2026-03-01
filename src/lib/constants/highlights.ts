/* ===== 하이라이트 릴 목업 데이터 ===== */

export interface Highlight {
  id: string;
  teamId: number;
  title: string;
  description: string;
  youtubeId: string; // YouTube video ID
  duration: string;
  viewCount: number;
  likeCount: number;
  commentCount: number;
  timeAgo: string;
  channel: string;
  type: "highlight" | "interview" | "analysis" | "vlog";
}

export const MOCK_HIGHLIGHTS: Highlight[] = [
  {
    id: "h1", teamId: 1,
    title: "오스틴 끝내기 3점 홈런! 🔥 잠실 폭발",
    description: "9회말 2사 만루 상황에서 오스틴의 극적인 끝내기 홈런! 잠실이 들썩였습니다.",
    youtubeId: "dQw4w9WgXcQ", duration: "1:24",
    viewCount: 342000, likeCount: 12400, commentCount: 891,
    timeAgo: "3시간 전", channel: "LG Twins TV", type: "highlight",
  },
  {
    id: "h2", teamId: 6,
    title: "김도영 시즌 28호 홈런 + 신들린 수비",
    description: "김도영의 괴물 같은 활약! 홈런에 수비까지 완벽한 하루",
    youtubeId: "dQw4w9WgXcQ", duration: "2:15",
    viewCount: 289000, likeCount: 9800, commentCount: 723,
    timeAgo: "5시간 전", channel: "KIA Tigers TV", type: "highlight",
  },
  {
    id: "h3", teamId: 2,
    title: "양의지 통산 1500안타 달성 순간 👏",
    description: "베테랑 포수 양의지, 역대 포수 최다 안타 기록 경신!",
    youtubeId: "dQw4w9WgXcQ", duration: "1:48",
    viewCount: 198000, likeCount: 8900, commentCount: 567,
    timeAgo: "8시간 전", channel: "Bears TV", type: "highlight",
  },
  {
    id: "h4", teamId: 8,
    title: "디아즈 시즌 35호! 역대 외국인 홈런 기록 타이",
    description: "삼성 디아즈, 압도적 파워로 리그를 지배하는 중",
    youtubeId: "dQw4w9WgXcQ", duration: "0:58",
    viewCount: 256000, likeCount: 7600, commentCount: 445,
    timeAgo: "1일 전", channel: "삼성 라이온즈 TV", type: "highlight",
  },
  {
    id: "h5", teamId: 9,
    title: "문동주 7이닝 무실점 역투 🔥 차세대 에이스",
    description: "한화 문동주, 104구로 7이닝 무실점 완벽 투구",
    youtubeId: "dQw4w9WgXcQ", duration: "3:22",
    viewCount: 167000, likeCount: 6200, commentCount: 389,
    timeAgo: "1일 전", channel: "한화 이글스 TV", type: "highlight",
  },
  {
    id: "h6", teamId: 1,
    title: "[인터뷰] 임찬규 \"올해는 반드시 우승한다\"",
    description: "시즌 10승 달성 후 임찬규 선수 인터뷰",
    youtubeId: "dQw4w9WgXcQ", duration: "4:12",
    viewCount: 89000, likeCount: 3400, commentCount: 234,
    timeAgo: "2일 전", channel: "LG Twins TV", type: "interview",
  },
  {
    id: "h7", teamId: 3,
    title: "강백호 역전 투런포! KT 짜릿한 승리",
    description: "8회 역전 투런홈런으로 경기를 뒤집은 강백호",
    youtubeId: "dQw4w9WgXcQ", duration: "1:35",
    viewCount: 145000, likeCount: 5100, commentCount: 312,
    timeAgo: "2일 전", channel: "KT Wiz TV", type: "highlight",
  },
  {
    id: "h8", teamId: 4,
    title: "[분석] 2026 SSG 전력 완전 분석",
    description: "SSG 랜더스의 올 시즌 전력을 데이터로 분석합니다",
    youtubeId: "dQw4w9WgXcQ", duration: "12:45",
    viewCount: 78000, likeCount: 2800, commentCount: 189,
    timeAgo: "3일 전", channel: "야구분석TV", type: "analysis",
  },
  {
    id: "h9", teamId: 5,
    title: "박민우 시즌 30도루! 역대 NC 도루왕",
    description: "NC 박민우의 화려한 도루 모음",
    youtubeId: "dQw4w9WgXcQ", duration: "2:08",
    viewCount: 112000, likeCount: 4300, commentCount: 267,
    timeAgo: "3일 전", channel: "NC 다이노스 TV", type: "highlight",
  },
  {
    id: "h10", teamId: 7,
    title: "사직 직관 브이로그 🏟️ 롯데 응원 현장",
    description: "사직구장에서의 하루! 먹거리부터 응원까지",
    youtubeId: "dQw4w9WgXcQ", duration: "8:30",
    viewCount: 67000, likeCount: 3100, commentCount: 198,
    timeAgo: "4일 전", channel: "야구브이로그", type: "vlog",
  },
  {
    id: "h11", teamId: 10,
    title: "안우진 복귀전 153km 강속구! MLB급 구위",
    description: "키움 안우진, MLB 복귀 후 첫 등판에서 압도적 구위 과시",
    youtubeId: "dQw4w9WgXcQ", duration: "2:45",
    viewCount: 234000, likeCount: 8100, commentCount: 534,
    timeAgo: "5일 전", channel: "키움 히어로즈 TV", type: "highlight",
  },
  {
    id: "h12", teamId: 6,
    title: "양현종 은퇴 경기 눈물의 마운드 😢",
    description: "KBO 레전드 양현종, 마지막 등판에서 관중 전원 기립 박수",
    youtubeId: "dQw4w9WgXcQ", duration: "5:18",
    viewCount: 567000, likeCount: 24000, commentCount: 1890,
    timeAgo: "1주 전", channel: "KIA Tigers TV", type: "highlight",
  },
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
