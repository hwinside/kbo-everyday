/* ===== 하이라이트 릴 — 실제 YouTube Shorts ===== */

export interface Highlight {
  id: string;
  teamId: number | null;
  playerNames?: string[]; // 관련 선수
  title: string;
  youtubeId: string;
  thumbnail: string;
  channel: string;
  timeAgo: string;
  recencyScore: number; // 최신순 가중치 (높을수록 최신)
}

export const HIGHLIGHTS: Highlight[] = [
  { id: "s1", teamId: 6, playerNames: ["김도영"], title: "김도영 타격폼 변화 (2022~2026) #shorts", youtubeId: "j794490FdYg", thumbnail: "https://i.ytimg.com/vi/j794490FdYg/hqdefault.jpg", channel: "야구팬 마린", timeAgo: "1주 전", recencyScore: 95 },
  { id: "s2", teamId: 4, playerNames: ["김재환"], title: "쓱재환 #김재환 #SSG랜더스", youtubeId: "cYJ91gtx8jY", thumbnail: "https://i.ytimg.com/vi/cYJ91gtx8jY/hqdefault.jpg", channel: "덕아웃 인천", timeAgo: "3일 전", recencyScore: 98 },
  { id: "s3", teamId: 8, title: "삼성라이온즈 초비상 #shorts", youtubeId: "gficM6vbLNk", thumbnail: "https://i.ytimg.com/vi/gficM6vbLNk/hqdefault.jpg", channel: "야구인물사전", timeAgo: "2일 전", recencyScore: 99 },
  { id: "s4", teamId: 9, playerNames: ["문현빈"], title: "문현빈 타격폼 변화 (2023~2026) #shorts", youtubeId: "i-caDywUd4c", thumbnail: "https://i.ytimg.com/vi/i-caDywUd4c/hqdefault.jpg", channel: "야구팬 마린", timeAgo: "1주 전", recencyScore: 93 },
  { id: "s5", teamId: 10, playerNames: ["서건창"], title: "서건창 타격폼 변화 #키움히어로즈", youtubeId: "3w1N305_Dss", thumbnail: "https://i.ytimg.com/vi/3w1N305_Dss/hqdefault.jpg", channel: "스포쿰", timeAgo: "5일 전", recencyScore: 96 },
  { id: "s6", teamId: 10, playerNames: ["김혜성"], title: "'베테랑 로하스'도 감탄한 김혜성의 호수비 #shorts", youtubeId: "Mpdsn2HBBgY", thumbnail: "https://i.ytimg.com/vi/Mpdsn2HBBgY/hqdefault.jpg", channel: "스포타임", timeAgo: "1주 전", recencyScore: 92 },
  { id: "s7", teamId: null, title: "홈런 콜급 리액션, 알고 보니 단타", youtubeId: "v8AatRj155g", thumbnail: "https://i.ytimg.com/vi/v8AatRj155g/hqdefault.jpg", channel: "야구짱", timeAgo: "4일 전", recencyScore: 97 },
  { id: "s8", teamId: 5, playerNames: ["권희동"], title: "[NC다이노스] 경기를 끝내는 권희동 호수비 #shorts", youtubeId: "wf0cAUrFEmU", thumbnail: "https://i.ytimg.com/vi/wf0cAUrFEmU/hqdefault.jpg", channel: "엔씨노트", timeAgo: "2주 전", recencyScore: 88 },
  { id: "s9", teamId: 8, playerNames: ["강민호"], title: "도루 잡고 도발하는 강민호", youtubeId: "Uo_bC01D-K0", thumbnail: "https://i.ytimg.com/vi/Uo_bC01D-K0/hqdefault.jpg", channel: "크보꿀잼", timeAgo: "1주 전", recencyScore: 91 },
  { id: "s10", teamId: 9, title: "KBO 최다연패 기록쓰는 한화", youtubeId: "uagw9_BD-zo", thumbnail: "https://i.ytimg.com/vi/uagw9_BD-zo/hqdefault.jpg", channel: "풀카운트", timeAgo: "3주 전", recencyScore: 82 },
  { id: "s11", teamId: 1, title: "이재원, 문정빈 우타자 2명의 엄청난 파워!", youtubeId: "wYIi8g6NvxU", thumbnail: "https://i.ytimg.com/vi/wYIi8g6NvxU/hqdefault.jpg", channel: "Twins Nation", timeAgo: "2일 전", recencyScore: 99 },
  { id: "s12", teamId: 6, playerNames: ["최형우"], title: "김영웅이 아쉽다는 최형우", youtubeId: "deXYLFksQuc", thumbnail: "https://i.ytimg.com/vi/deXYLFksQuc/hqdefault.jpg", channel: "호망", timeAgo: "3일 전", recencyScore: 98 },
  { id: "s13", teamId: 2, title: "두산 새 응원가 언제 나올까!?", youtubeId: "xLjh1E8tA_Q", thumbnail: "https://i.ytimg.com/vi/xLjh1E8tA_Q/hqdefault.jpg", channel: "지캐TV", timeAgo: "1주 전", recencyScore: 90 },
  { id: "s14", teamId: 7, playerNames: ["윤성빈"], title: "지바 롯데 참교육하는 윤성빈", youtubeId: "wJKuSo0tQ_o", thumbnail: "https://i.ytimg.com/vi/wJKuSo0tQ_o/hqdefault.jpg", channel: "엠엘비 센터", timeAgo: "1주 전", recencyScore: 89 },
  { id: "s15", teamId: 1, title: "중견수 천성호의 발견! '트중천'", youtubeId: "5nM46tbOJlE", thumbnail: "https://i.ytimg.com/vi/5nM46tbOJlE/hqdefault.jpg", channel: "Twins Nation", timeAgo: "2일 전", recencyScore: 100 },
  // 이전 하이라이트 (가로형도 포함)
  { id: "h1", teamId: 1, title: "LG vs 한화 [2024 정규시즌 하이라이트]", youtubeId: "rOOwMC-bFec", thumbnail: "https://i.ytimg.com/vi/rOOwMC-bFec/hqdefault.jpg", channel: "LGTWINSTV", timeAgo: "6개월 전", recencyScore: 30 },
  { id: "h2", teamId: null, title: "[2025 RECAP] 크보를 빛낸 명장면 모음zip", youtubeId: "Y5XDaz8QOgQ", thumbnail: "https://i.ytimg.com/vi/Y5XDaz8QOgQ/hqdefault.jpg", channel: "TVING SPORTS", timeAgo: "1개월 전", recencyScore: 70 },
  { id: "h3", teamId: null, title: "KBO 역대 최고의 홈런 모음 (1982~2023)", youtubeId: "Pjsc96S4WWo", thumbnail: "https://i.ytimg.com/vi/Pjsc96S4WWo/hqdefault.jpg", channel: "KABY BASEBALL", timeAgo: "1년 전", recencyScore: 10 },
  { id: "h4", teamId: null, title: "[2025 KBO결산] 소름 돋는 최고의 호수비 TOP10", youtubeId: "6fP5Q9a_db8", thumbnail: "https://i.ytimg.com/vi/6fP5Q9a_db8/hqdefault.jpg", channel: "스탐", timeAgo: "2개월 전", recencyScore: 60 },
];

/* ===== 피드 알고리즘 ===== */
export function rankHighlights(
  highlights: Highlight[],
  myTeamId: number | null,
  favoritePlayerNames?: string[],
): Highlight[] {
  return [...highlights].sort((a, b) => {
    let scoreA = a.recencyScore;
    let scoreB = b.recencyScore;

    // 마이팀 가중치 (+30)
    if (myTeamId) {
      if (a.teamId === myTeamId) scoreA += 30;
      if (b.teamId === myTeamId) scoreB += 30;
    }

    // 관심 선수 가중치 (+20)
    if (favoritePlayerNames?.length) {
      if (a.playerNames?.some(p => favoritePlayerNames.includes(p))) scoreA += 20;
      if (b.playerNames?.some(p => favoritePlayerNames.includes(p))) scoreB += 20;
    }

    return scoreB - scoreA;
  });
}
