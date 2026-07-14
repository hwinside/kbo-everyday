"use client";

interface Props {
  playerName: string;
  teamColor: string;
  kboId?: string;
}

// 🚧 선수 프로필 전체 비노출 (품질 검증 후 재오픈 예정)
// 사유: 나무위키 스팸/오염 데이터 유입 + 동명이인 미파싱 + 빈 프로필 다수
//
// ⚠️ 재오픈 시 주의: PLAYER_PROFILES(약 3.1MB) 정적 import 금지.
//   컴포넌트가 return null 로 비활성인데도 이 정적 import 때문에 3.1MB가 client 번들에
//   그대로 실려 날라가고 있어서 제거함 (클라 번들 다이어트).
//   재오픈은 서버 라우트(예: /api/player-profile?name=)에서 해당 선수 1명치만 fetch하는
//   방식으로 할 것 — 전체 프로필을 client로 import하지 말 것.
// props는 재오픈 시 사용 예정이라 호출부 계약 유지를 위해 시그니처만 남겨둠.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export default function PlayerProfile(_props: Props) {
  return null;
}
