export interface BadgeDefinition {
  id: string;
  name: string;
  icon: string;
  description: string;
  category: "fan" | "predict" | "community" | "knowledge" | "special" | "season";
  rarity: "common" | "rare" | "epic" | "legendary";
}

export const BADGES: BadgeDefinition[] = [
  // === 특별 ===
  { id: "founder", name: "파운더", icon: "👑", description: "크보 에브리데이 초창기 멤버", category: "special", rarity: "legendary" },
  { id: "wiki", name: "위키 기여자", icon: "📝", description: "선수 프로필 제보 채택", category: "special", rarity: "epic" },
  { id: "bug-hunter", name: "버그헌터", icon: "🐛", description: "버그 제보로 앱 개선에 기여", category: "special", rarity: "epic" },

  // === 커뮤니티 ===
  { id: "debut", name: "데뷔전", icon: "🎬", description: "첫 글 작성", category: "community", rarity: "common" },
  { id: "writer-1", name: "수다쟁이 Lv.1", icon: "💬", description: "글+댓글 10개 달성", category: "community", rarity: "common" },
  { id: "writer-2", name: "수다쟁이 Lv.2", icon: "💬", description: "글+댓글 30개 달성", category: "community", rarity: "common" },
  { id: "writer-3", name: "수다쟁이 Lv.3", icon: "💬", description: "글+댓글 70개 달성", category: "community", rarity: "rare" },
  { id: "writer-4", name: "수다쟁이 Lv.4", icon: "💬", description: "글+댓글 150개 달성", category: "community", rarity: "epic" },
  { id: "writer-5", name: "수다쟁이 Lv.5", icon: "💬", description: "글+댓글 300개 달성", category: "community", rarity: "legendary" },
  { id: "popular-1", name: "인기스타 Lv.1", icon: "❤️", description: "받은 좋아요 10개", category: "community", rarity: "common" },
  { id: "popular-2", name: "인기스타 Lv.2", icon: "❤️", description: "받은 좋아요 50개", category: "community", rarity: "rare" },
  { id: "popular-3", name: "인기스타 Lv.3", icon: "❤️", description: "받은 좋아요 100개", category: "community", rarity: "rare" },
  { id: "popular-4", name: "인기스타 Lv.4", icon: "❤️", description: "받은 좋아요 300개", category: "community", rarity: "epic" },
  { id: "popular-5", name: "인기스타 Lv.5", icon: "❤️", description: "받은 좋아요 1000개", category: "community", rarity: "legendary" },
  { id: "attendance-7", name: "개근상 7일", icon: "📅", description: "7일 연속 출석", category: "community", rarity: "common" },
  { id: "attendance-30", name: "개근상 30일", icon: "📅", description: "30일 연속 출석", category: "community", rarity: "rare" },
  { id: "attendance-100", name: "개근상 100일", icon: "📅", description: "100일 연속 출석", category: "community", rarity: "epic" },

  // === 예측 ===
  { id: "predictor-1", name: "예언자 Lv.1", icon: "🔮", description: "예측 적중 5회", category: "predict", rarity: "common" },
  { id: "predictor-2", name: "예언자 Lv.2", icon: "🔮", description: "예측 적중 15회", category: "predict", rarity: "rare" },
  { id: "predictor-3", name: "예언자 Lv.3", icon: "🔮", description: "예측 적중 30회", category: "predict", rarity: "rare" },
  { id: "predictor-4", name: "예언자 Lv.4", icon: "🔮", description: "예측 적중 60회", category: "predict", rarity: "epic" },
  { id: "predictor-5", name: "예언자 Lv.5", icon: "🔮", description: "예측 적중 100회", category: "predict", rarity: "legendary" },
  { id: "streak-3", name: "3연속 적중", icon: "🔥", description: "예측 3연속 적중", category: "predict", rarity: "common" },
  { id: "streak-5", name: "5연속 적중", icon: "🔥", description: "예측 5연속 적중", category: "predict", rarity: "rare" },
  { id: "streak-10", name: "10연속 적중", icon: "🔥", description: "예측 10연속 적중", category: "predict", rarity: "legendary" },
  { id: "first-predict", name: "개막전 선봉대", icon: "🎯", description: "시즌 첫 예측 참여", category: "predict", rarity: "common" },

  // === 팬 활동 ===
  { id: "fan-player-1", name: "덕후 Lv.1", icon: "⭐", description: "선수 게시판 활동 5회", category: "fan", rarity: "common" },
  { id: "fan-player-2", name: "덕후 Lv.2", icon: "⭐", description: "선수 게시판 활동 15회", category: "fan", rarity: "common" },
  { id: "fan-player-3", name: "덕후 Lv.3", icon: "⭐", description: "선수 게시판 활동 30회", category: "fan", rarity: "rare" },
  { id: "fan-player-4", name: "덕후 Lv.4", icon: "⭐", description: "선수 게시판 활동 60회", category: "fan", rarity: "epic" },
  { id: "fan-player-5", name: "덕후 Lv.5", icon: "⭐", description: "선수 게시판 활동 100회", category: "fan", rarity: "legendary" },
  { id: "fan-team-1", name: "광팬 Lv.1", icon: "🏟️", description: "팀 게시판 활동 5회", category: "fan", rarity: "common" },
  { id: "fan-team-2", name: "광팬 Lv.2", icon: "🏟️", description: "팀 게시판 활동 15회", category: "fan", rarity: "common" },
  { id: "fan-team-3", name: "광팬 Lv.3", icon: "🏟️", description: "팀 게시판 활동 30회", category: "fan", rarity: "rare" },
  { id: "fan-team-4", name: "광팬 Lv.4", icon: "🏟️", description: "팀 게시판 활동 60회", category: "fan", rarity: "epic" },
  { id: "fan-team-5", name: "광팬 Lv.5", icon: "🏟️", description: "팀 게시판 활동 100회", category: "fan", rarity: "legendary" },
  { id: "photographer-1", name: "파파라치 Lv.1", icon: "📸", description: "직찍 업로드 5장", category: "fan", rarity: "common" },
  { id: "photographer-2", name: "파파라치 Lv.2", icon: "📸", description: "직찍 업로드 20장", category: "fan", rarity: "rare" },
  { id: "photographer-3", name: "파파라치 Lv.3", icon: "📸", description: "직찍 업로드 50장", category: "fan", rarity: "epic" },

  // === 지식 ===
  { id: "graduate", name: "야구학도", icon: "🎓", description: "야구 튜토리얼 전체 완료", category: "knowledge", rarity: "rare" },
  { id: "analyst", name: "분석가", icon: "📊", description: "세이버메트릭스 10회 조회", category: "knowledge", rarity: "common" },
  { id: "explorer", name: "KBO 탐험가", icon: "🗺️", description: "10팀 페이지 모두 방문", category: "knowledge", rarity: "rare" },

  // === 시즌 한정 ===
  { id: "first-pitch-2026", name: "2026 퍼스트피치", icon: "⚾", description: "2026 시즌 개막전 참여", category: "season", rarity: "epic" },
  { id: "autumn-2026", name: "가을야구 생존자", icon: "🍂", description: "2026 포스트시즌 활동", category: "season", rarity: "epic" },
];

export const BADGE_MAP = Object.fromEntries(BADGES.map(b => [b.id, b]));

export const RARITY_COLORS: Record<string, string> = {
  common: "#9CA3AF",
  rare: "#3B82F6",
  epic: "#8B5CF6",
  legendary: "#F59E0B",
};

export const CATEGORY_LABELS: Record<string, string> = {
  special: "🌟 특별",
  community: "💬 커뮤니티",
  predict: "🔮 예측",
  fan: "⚾ 팬 활동",
  knowledge: "📚 지식",
  season: "🏆 시즌 한정",
};
