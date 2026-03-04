/** 2026 KBO 시범경기 일정 (3/12~3/24, 전 경기 13:00) */
export interface PreseasonGame {
  date: string; // YYYY-MM-DD
  away: string;
  home: string;
  venue: string;
}

export const PRESEASON_GAMES: PreseasonGame[] = [
  // 3/12 (목)
  { date: "2026-03-12", away: "키움", home: "두산", venue: "이천(두산)" },
  { date: "2026-03-12", away: "삼성", home: "한화", venue: "대전" },
  { date: "2026-03-12", away: "SSG", home: "KIA", venue: "광주" },
  { date: "2026-03-12", away: "KT", home: "롯데", venue: "사직" },
  { date: "2026-03-12", away: "LG", home: "NC", venue: "마산" },
  // 3/13 (금)
  { date: "2026-03-13", away: "키움", home: "두산", venue: "이천(두산)" },
  { date: "2026-03-13", away: "삼성", home: "한화", venue: "대전" },
  { date: "2026-03-13", away: "SSG", home: "KIA", venue: "광주" },
  { date: "2026-03-13", away: "KT", home: "롯데", venue: "사직" },
  { date: "2026-03-13", away: "LG", home: "NC", venue: "마산" },
  // 3/14 (토)
  { date: "2026-03-14", away: "삼성", home: "두산", venue: "이천(두산)" },
  { date: "2026-03-14", away: "SSG", home: "한화", venue: "대전" },
  { date: "2026-03-14", away: "KT", home: "KIA", venue: "광주" },
  { date: "2026-03-14", away: "LG", home: "롯데", venue: "사직" },
  { date: "2026-03-14", away: "키움", home: "NC", venue: "마산" },
  // 3/15 (일)
  { date: "2026-03-15", away: "삼성", home: "두산", venue: "이천(두산)" },
  { date: "2026-03-15", away: "SSG", home: "한화", venue: "대전" },
  { date: "2026-03-15", away: "KT", home: "KIA", venue: "광주" },
  { date: "2026-03-15", away: "LG", home: "롯데", venue: "사직" },
  { date: "2026-03-15", away: "키움", home: "NC", venue: "마산" },
  // 3/16 (월)
  { date: "2026-03-16", away: "삼성", home: "SSG", venue: "문학" },
  { date: "2026-03-16", away: "LG", home: "KT", venue: "수원" },
  { date: "2026-03-16", away: "두산", home: "한화", venue: "대전" },
  { date: "2026-03-16", away: "키움", home: "롯데", venue: "사직" },
  { date: "2026-03-16", away: "KIA", home: "NC", venue: "창원" },
  // 3/17 (화)
  { date: "2026-03-17", away: "삼성", home: "SSG", venue: "문학" },
  { date: "2026-03-17", away: "LG", home: "KT", venue: "수원" },
  { date: "2026-03-17", away: "두산", home: "한화", venue: "대전" },
  { date: "2026-03-17", away: "키움", home: "롯데", venue: "사직" },
  { date: "2026-03-17", away: "KIA", home: "NC", venue: "창원" },
  // 3/18 (수) 휴식일
  // 3/19 (목)
  { date: "2026-03-19", away: "LG", home: "SSG", venue: "문학" },
  { date: "2026-03-19", away: "키움", home: "KT", venue: "수원" },
  { date: "2026-03-19", away: "KIA", home: "한화", venue: "대전" },
  { date: "2026-03-19", away: "두산", home: "롯데", venue: "사직" },
  { date: "2026-03-19", away: "삼성", home: "NC", venue: "창원" },
  // 3/20 (금)
  { date: "2026-03-20", away: "LG", home: "SSG", venue: "문학" },
  { date: "2026-03-20", away: "키움", home: "KT", venue: "수원" },
  { date: "2026-03-20", away: "KIA", home: "한화", venue: "대전" },
  { date: "2026-03-20", away: "두산", home: "롯데", venue: "사직" },
  { date: "2026-03-20", away: "삼성", home: "NC", venue: "창원" },
  // 3/21 (토)
  { date: "2026-03-21", away: "KIA", home: "두산", venue: "잠실" },
  { date: "2026-03-21", away: "키움", home: "SSG", venue: "문학" },
  { date: "2026-03-21", away: "NC", home: "KT", venue: "수원" },
  { date: "2026-03-21", away: "LG", home: "삼성", venue: "대구" },
  { date: "2026-03-21", away: "한화", home: "롯데", venue: "사직" },
  // 3/22 (일)
  { date: "2026-03-22", away: "KIA", home: "두산", venue: "잠실" },
  { date: "2026-03-22", away: "키움", home: "SSG", venue: "문학" },
  { date: "2026-03-22", away: "NC", home: "KT", venue: "수원" },
  { date: "2026-03-22", away: "LG", home: "삼성", venue: "대구" },
  { date: "2026-03-22", away: "한화", home: "롯데", venue: "사직" },
  // 3/23 (월)
  { date: "2026-03-23", away: "키움", home: "LG", venue: "잠실" },
  { date: "2026-03-23", away: "롯데", home: "SSG", venue: "문학" },
  { date: "2026-03-23", away: "두산", home: "KT", venue: "수원" },
  { date: "2026-03-23", away: "NC", home: "한화", venue: "대전" },
  { date: "2026-03-23", away: "KIA", home: "삼성", venue: "대구" },
  // 3/24 (화)
  { date: "2026-03-24", away: "키움", home: "LG", venue: "잠실" },
  { date: "2026-03-24", away: "롯데", home: "SSG", venue: "문학" },
  { date: "2026-03-24", away: "두산", home: "KT", venue: "수원" },
  { date: "2026-03-24", away: "NC", home: "한화", venue: "대전" },
  { date: "2026-03-24", away: "KIA", home: "삼성", venue: "대구" },
];

export const PRESEASON_DATES = [...new Set(PRESEASON_GAMES.map(g => g.date))].sort();
