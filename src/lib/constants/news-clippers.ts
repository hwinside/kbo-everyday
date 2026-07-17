// 팀별 뉴스클리퍼 발신 계정 — 클리핑 쪽지를 운영팀 계정과 분리해 CS 인입함
// 오염 방지 (2026-07-11 하린아빠). 계정은 scripts/setup-news-clipper-accounts.ts로
// prod에 생성된 실계정(auth.users + profiles "{팀} 뉴스클리퍼").
// 서버(cron·디스패처)와 클라(쪽지 카드 렌더/입력창 안내) 공용.

export const NEWS_CLIPPER_BY_TEAM: Record<number, string> = {
  1: "3a1cc8b4-591b-4013-8901-17475c7634a0", // LG 뉴스클리퍼
  2: "70415eb6-b749-4aec-a356-9990b3f0ff8c", // 두산 뉴스클리퍼
  3: "25923374-d765-4eec-99ad-09fd10370686", // KT 뉴스클리퍼
  4: "6b88356b-0d41-430b-ac8d-09d4563fe8f0", // SSG 뉴스클리퍼
  5: "2b35463e-46ce-487b-bf27-3c600d9dbde2", // NC 뉴스클리퍼
  6: "f0a17c3b-c66a-4ce6-9dfa-ff1827f94cde", // KIA 뉴스클리퍼
  7: "eda77471-8008-4ea9-af79-18ca79c9642c", // 롯데 뉴스클리퍼
  8: "f37ae4d0-9331-4254-a815-55e73679dfec", // 삼성 뉴스클리퍼
  9: "b9676cf8-810f-41ba-a2a4-6944b32fe668", // 한화 뉴스클리퍼
  10: "15c06f79-137c-44bb-a6e8-29c8a63d297f", // 키움 뉴스클리퍼
};

export const NEWS_CLIPPER_IDS = new Set(Object.values(NEWS_CLIPPER_BY_TEAM));

/** 클리퍼 계정으로 답장 시 1회 자동응답 문구 (하린아빠 지정) */
export const CLIPPER_AUTO_REPLY_TEXT =
  "뉴스클리퍼 계정은 쪽지 수신이 불가능합니다. 건의하실 내용이 있다면 '피드백 보내기'를 이용해주세요.";
