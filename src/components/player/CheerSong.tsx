"use client";

import { useState } from "react";
import { Music, Play, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import GlassCard from "@/components/ui/GlassCard";

interface CheerSongData {
  title: string;
  lyrics: string;
  youtubeUrl?: string;
  note?: string;
}

const CHEER_SONGS: Record<string, CheerSongData> = {
  "강민호": {
    title: "강민호 응원가",
    lyrics: "5.3.1. 응원가 1\n바그너 - 쌍두 독수리 깃발 아래서\n라이온즈 안방마님 강민호!\n최강사자 강~민호~\n라이온즈 안방마님 강민호!\n날려버려 강! 민! 호!\n라이온즈 안방마님 강민호!\n최강사자 강~민호~\n라이온즈 안방마님 강민호!\n날려버려 강! 민! 호!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+강민호+응원가",
  },
  "강백호": {
    title: "강백호 응원가",
    lyrics: "등장곡 : 모네스킨 - Beggin'",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+강백호+응원가",
  },
  "강승호": {
    title: "강승호 응원가",
    lyrics: "금나라 - 앵콜 (2021.10.23~)\n강승호 안타! 강승호 안타! 최강두산 강승호~\n강승호~ 두산의 강승호~ 강! 승! 호! [X2]\n한재권 단장이 직접 불렀다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+강승호+응원가",
  },
  "고승민": {
    title: "고승민 응원가",
    lyrics: "롯~데의~ 고승민 안타 안타~\n롯~데의~ 고승민 안타 안타~\n워어어 워어어 워어어어~\n워어어 워어어 워어어어~\n롯~데의~ 고승민 안타 안타~",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+고승민+응원가",
  },
  "고종욱": {
    title: "고종욱 응원가",
    lyrics: "GO! 종욱 GO! 종욱 히어로 고종욱\nGO! 종욱 GO! 종욱 고종욱이 달려간다\nGO! 종욱 GO! 종욱 히어로 고종욱\nGO! 종욱 GO! 종욱 고종욱이 달려간다\n노브레인 - 슛돌이\n히어로 고종욱 날려버려 고종욱 오예\n히어로 고종욱 폭풍질주 고종욱 오예\n히어로 고종욱 날려버려 고종욱 오예\n히어로 고종욱 폭풍질주 고종욱 오예\nNOW~ 고종욱! 고종욱! 고종욱! 고종욱!\n크라잉넛 - 부딪쳐\n3.3.10. 샌즈(2018~2019)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+고종욱+응원가",
  },
  "구승민": {
    title: "구승민 응원가",
    lyrics: "Sam Tinnesz - Legends Are Made",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+구승민+응원가",
  },
  "구자욱": {
    title: "구자욱 응원가",
    lyrics: "2.4.1. 응원가 1\n최강 삼성 구자욱!\n치고 달려 구자욱!\n시원하게 한방!\n날! 려! 버! 려! 구! 자! 욱!\n최강 삼성 구자욱!\n치고 달려 구자욱!\n시원하게 한방!\n날! 려! 버! 려! 구! 자! 욱!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+구자욱+응원가",
  },
  "권광민": {
    title: "권광민 응원가",
    lyrics: "등장곡 : G-DRAGON (지드래곤) - HOME SWEET HOME",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+권광민+응원가",
  },
  "권희동": {
    title: "권희동 응원가",
    lyrics: "다이노스 오~ 권희동\nNC 오! 권희동 오! 권희동 권희동 안타~ NC 오! 권희동 오! 권희동 오~ 오오오~ 권! 희! 동!\nNC 오! 권희동 오! 권희동 권희동 안타~ NC 오! 권희동 오! 권희동 오~ 오오오~ 권! 희! 동!\n2020 시즌 새롭게 공개된 응원가.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+권희동+응원가",
  },
  "김규민": {
    title: "김규민 응원가",
    lyrics: "히어로 김규민 워어어어~ 히어로 김규민 워어어어~\n승리를 위해 외쳐보자~ 히!어!로!즈! 김규민~\n히어로 김규민 워어어어~ 히어로 김규민 워어어어~\n승리를 위해 외쳐보자~ 히!어!로!즈! 김규민~\n브이 브이 브이 브이 김규민~ 히어로즈 김규민~\n승리를 위해 날려버려~ 오~~~~ 김!규!민!\n브이 브이 브이 브이 김규민~ 히어로즈 김규민~\n승리를 위해 날려버려~ 오~~~~ 김!규!민!\n또봇V 주제가\n히어로 김규민 오 날쌘돌이 김규민\n히어로 김규민 승리를 위해 워어어\n히어로 김규민 오 날쌘돌이 김규민\n히어로 김규민 승리를 위해 워어어 날려버려\n3.3.13. 허정협(2015~2021)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+김규민+응원가",
  },
  "김규성": {
    title: "김규성 응원가",
    lyrics: "듣기\nKIA 타이거즈\n지금부터 시작해봐 앞을 달려\nRunning running 세상에 소리쳐\n막다른 길이 나타나도 난 괜찮아 (김! 규! 성!)\n응원가 (이승환 - 슈퍼히어로)\n듣기\nKIA 타이거즈\nKIA 김규성\n타이거즈 김규성\n최강 KIA 승리를 위하여\n날려버려라\nKIA 김규성\n타이거즈 김규성\n최강 KIA 승리를 위하여\nKIA! 김!규!성!",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+김규성+응원가",
  },
  "김기연": {
    title: "김기연 응원가",
    lyrics: "김~기~연~ 안타 날려라! 김기연 홈런 날려라!\n베어스 승리 위해 오오오 김~기~연~\n김기연 안타 날려라! 김기연 홈런 날려라!\n베어스의 승리 위하여~ 오~ 김! 기! 연!",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+김기연+응원가",
  },
  "김대한": {
    title: "김대한 응원가",
    lyrics: "두산의 김대한 안타! 안타 워어어어! [X4]",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+김대한+응원가",
  },
  "김대현": {
    title: "김대현 응원가",
    lyrics: "김대민 - King Is Back",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김대현+응원가",
  },
  "김도영": {
    title: "김도영 응원가",
    lyrics: "듣기\nKIA 타이거즈\n오오 오오(헤이!) 오오 오오(헤이!)\nKI! A! 김! 도! 영!\n오오 오오(헤이!) 오오 오오(헤이!)\nKI! A! 김! 도! 영!\n응원가 (럼블 피쉬 - Smile Again)\n듣기\n국가대표\n김~도영~ 힘차게 날려라~ 한국의 승리를 위하여 워어어어~ 워우워~ 날려라~×2\nKIA 타이거즈\n김~도영~ 힘차게 날려라~ KIA의 승리를 위하여 워어어어~ 워우워~ 날려라~×2\n[이전 등장곡 보기]\n[이전 응원가 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+김도영+응원가",
  },
  "김도환": {
    title: "김도환 응원가",
    lyrics: "김도환! 김도환! 화니화니 안타!\n김도환! 김도환! 워우워우워~\n김도환! 김도환! 화니화니 안타!\n김도환! 김도환! 워우워우워~\n김도환! 김도환! 화니화니 안타!\n김도환! 김도환! 워우워우워~\n김도환! 김도환! 화니화니 안타!\n김도환! 김도환! 워우워우워~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+김도환+응원가",
  },
  "김무신": {
    title: "김무신 응원가",
    lyrics: "● Zayde Wolf - KING",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+김무신+응원가",
  },
  "김민석": {
    title: "김민석 응원가",
    lyrics: "두산의 김~민석 힘차게 치고 달려라!\n두산의 김~민석 승리를 위해 날려라!\n오오오오오오오오 승리를 위해~[X2]",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+김민석+응원가",
  },
  "김민성": {
    title: "김민성 응원가",
    lyrics: "김민성 안타 날려라 안타 김민성 홈런 날려라 홈런\n우리의 영웅 넥센의 김민성 워우워어 승리를 위해\n김민성 안타 날려라 안타 김민성 홈런 날려라 홈런\n우리의 영웅 넥센의 김민성 워우워어 승리를 위해\n김민성! 김민성! 김민성! 김민성!\n크라잉넛 - 여름\n김민성 안타안타 날려줘요 김민성 김민성!\n김민성 안타안타 날려줘요 김민성 오~\n김민성 안타안타 날려줘요 김민성 김민성!\n김민성 안타안타 날려줘요 김민성 오~\nABBA - waterloo\n김민성! 김민성! 오 오 히어로즈 김민성\n김민성! 김민성! 오 오 히어로즈 김민성\n노라조 - 사랑가\n김민성 안타 오오오오 히어로즈 김민성 안타\n김민성 안타 오오오오 히어로즈 김민성 안타\n김민성 안타 오오오오 히어로즈 김민성 안타\n김민성 안타 오오오오 히어로즈 김민성 안타\n3.2.6. 김지수(2009~2019)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+김민성+응원가",
  },
  "김민수": {
    title: "김민수 응원가",
    lyrics: "롯데의 김민수 안타~\n오오오 오오오~ 오오~\n롯데의 김민수 안타~\n오오오 오오오~ x2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+김민수+응원가",
  },
  "김상수": {
    title: "김상수 응원가",
    lyrics: "드렁큰 타이거 - 난 널 원해",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+김상수+응원가",
  },
  "김석환": {
    title: "김석환 응원가",
    lyrics: "KIA 타이거즈\nGirl 말해줘 네 마음 바로 지금\nBaby 같이 올라가자 하늘 위로\nAll I wanna do is kick it with you (김석환!)\n너의 몸매 그린 것만 같아 미술\n오늘 의상처럼 네 마음도 씨쓰루\nAll I wanna do is kick it with you (김석환!)\n응원가 (자작곡)\n듣기\nKIA 타이거즈\n최강 KIA의 김석환 안타\n최강 KIA의 김석환 안타\n워어~ 워어어어어어~\n최강 KIA 김석환 안타\n최강 KIA의 김석환 안타\n최강 KIA의 김석환 안타\n워어~ 워어어어어어~\n최강 KIA 김석환 안타\n[이전 등장곡 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+김석환+응원가",
  },
  "김선빈": {
    title: "김선빈 응원가",
    lyrics: "등장곡, 응원가 듣기",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+김선빈+응원가",
  },
  "김성욱": {
    title: "김성욱 응원가",
    lyrics: "NC 김성욱 다이노스 김성욱\nNC 김성욱 다이노스 승리를 위해 [A]\n2025년 6월 7일 2026 시즌 4라운드 지명권 + 5천만원에 SSG 랜더스로 트레이드 되었다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+김성욱+응원가",
  },
  "김영우": {
    title: "김영우 응원가",
    lyrics: "Conner Price,Zensery - Drop",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김영우+응원가",
  },
  "김영웅": {
    title: "김영웅 응원가",
    lyrics: "최강 삼성 히어로 누구? 김! 영! 웅!\n승리의 안타를 날려라~\n최강 삼성 히어로 누구? 김! 영! 웅!\n워어어어어어어~\n최강 삼성 히어로 누구? 김! 영! 웅!\n승리의 홈런을 날려라~\n최강 삼성 히어로 누구? 김! 영! 웅!\n워어어어어어어~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+김영웅+응원가",
  },
  "김원중": {
    title: "김원중 응원가",
    lyrics: "AC/DC - Hells Bells",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+김원중+응원가",
  },
  "김유영": {
    title: "김유영 응원가",
    lyrics: "싸이 - 챔피언(Remake & Mix 18번)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김유영+응원가",
  },
  "김인태": {
    title: "김인태 응원가",
    lyrics: "날려라 날~ 려라 날려라~ 두~ 산의 김인태~\n안타 안타 김인태! 최! 강! 두! 산! 김인태! [X2]",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+김인태+응원가",
  },
  "김재상": {
    title: "김재상 응원가",
    lyrics: "삼성의 김재상! 안타 날려버려라~\n삼성 김재상~ 워어어어어!\n삼성의 김재상! 안타 날려버려라~\n삼성 김재상~ 화! 이! 팅!\n삼성의 김재상! 안타 날려버려라~\n삼성 김재상~ 워어어어어!\n삼성의 김재상! 안타 날려버려라~\n삼성 김재상~ 화! 이! 팅!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+김재상+응원가",
  },
  "김재성": {
    title: "김재성 응원가",
    lyrics: "삼성 김재성~ 오오오 김재성~\n승리를 위하여~ 한방 날려버려!\n김재성~ 오오오 김재성~!\n삼성의 김재성~\n삼성 김재성~ 오오오 김재성~\n승리를 위하여~ 한방 날려버려!\n김재성~ 오오오 김재성~!\n삼성의 김재성~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+김재성+응원가",
  },
  "김정율": {
    title: "김정율 응원가",
    lyrics: "안타 안타 LG 김정율\n안타 안타 LG 김정율\n안타 안타 LG 김정율\n오! 김정율 ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김정율+응원가",
  },
  "김주성": {
    title: "김주성 응원가",
    lyrics: "오 LG 김주~성 오 LG 김주~성\n오 LG 김주~성 워~어어어어\n힘차게 달려가라 L~G 김~주성 (한 번 더!)\n오 LG 김주~성 오 LG 김주~성\n오 LG 김주~성 워~어어어어\n힘차게 달려가라 L~G 김~주성",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김주성+응원가",
  },
  "김주원": {
    title: "김주원 응원가",
    lyrics: "다이노 김주원~\n오~ NC 김주원 힘차게 달려 라랄랄라 오오오~ NC 김주원 승리를 위해 라랄라\n오~ NC 김주원 힘차게 달려 라랄랄라 오오오~ NC 김주원 승리를 위해 라랄라\n다이노스~ 김! 주! 원!",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+김주원+응원가",
  },
  "김진성": {
    title: "김진성 응원가",
    lyrics: "50 cent - Ready For War",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김진성+응원가",
  },
  "김진수": {
    title: "김진수 응원가",
    lyrics: "paper kings - fire on up",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+김진수+응원가",
  },
  "김진욱": {
    title: "김진욱 응원가",
    lyrics: "시아 - Unstoppable",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+김진욱+응원가",
  },
  "김형준": {
    title: "김형준 응원가",
    lyrics: "오오오 NC 김형준! 오~오 오오오오\n다이노스 승리를 위~해 NC 김형준 (김!형!준!) X2[A]\n1.2. 내야수\n1.2.1. No.2 박민우",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+김형준+응원가",
  },
  "김호령": {
    title: "김호령 응원가",
    lyrics: "KIA 타이거즈\n우리가 기다린 미래도 우릴 기다릴까\n분명한 건 지금보다 환하게\n빛날 거야 아직 서막일 뿐야\n푸르른 공기가 날\n응원가 (강준우 - Go! Korea)\n듣기\nKIA 타이거즈\n오오오 김호령~ 오오오오 김호령\n호령 호령 김호령 타이거즈 김호령\n오오오 김호령~ 오오오오 김호령\n호령 호령 김호령~ 타이거즈 김호령 화이팅!\n[이전 등장곡, 응원가 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+김호령+응원가",
  },
  "노시환": {
    title: "노시환 응원가",
    lyrics: "응원가 : 트랜스픽션 - Mary Jane 응원가 듣기\n오! 노시환 워어어 워어어어 날려줘요 환상적으로! 날려버려 노시환!\n오! 노시환 워어어 워어어어 날려줘요 환상적으로! 안타! 홈런! 워어어어 노!시!환!",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+노시환+응원가",
  },
  "노진혁": {
    title: "노진혁 응원가",
    lyrics: "롯데 노진혁~\n롯데 노진혁 오오오~\n안타 홈런 오오오 오오오오~\n안타 홈런 오오오 오오오오~ ×2\n롯데 노진혁~",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+노진혁+응원가",
  },
  "데이비슨": {
    title: "데이비슨 응원가",
    lyrics: "데이비슨 오오 데이비슨 오오오오 데이비슨 오오 NC 다이노스 데! 이! 비! 슨![A]\n여담으로 응원가가 공개되자, 팬들은 음원 속 목소리가 팀 동료 손아섭과 비슷하다며 손아섭이 부른 게 아니냐는 드립이 나오기도 했다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+데이비슨+응원가",
  },
  "디아즈": {
    title: "디아즈 응원가",
    lyrics: "라이온즈의 디아즈\n디아즈 오오 디아즈\n승리를 위해 디아즈\n디아즈 워어어어어 VIVA!\n라이온즈의 디아즈\n디아즈 오오 디아즈\n승리를 위해 디아즈\n디아즈 워어어어어 VIVA!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+디아즈+응원가",
  },
  "류승민": {
    title: "류승민 응원가",
    lyrics: "삼성의 류승민~\n승리를 위하여~\n안타를 날려! 날려! 날려! 날려버려라!\n삼성 류승민~\n삼성의 류승민~\n승리를 위하여~\n안타를 날려! 날려! 날려! 날려버려라!\n삼성 류승민~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+류승민+응원가",
  },
  "류지혁": {
    title: "류지혁 응원가",
    lyrics: "류~ 류~ 류~ 류~ 삼! 성! 류! 지! 혁!\n류지혁 워어어어~\n날려버려 워어어어~\n시원하고 화끈하게 류! 지! 혁! (가자!)\n류지혁 워어어어~ 삼성 류지혁~!\n최강 삼성 승리를 위해~ 류! 지! 혁!\n류지혁 워어어어~\n날려버려 워어어어~\n시원하고 화끈하게 류! 지! 혁! (가자!)\n류지혁 워어어어~ 삼성 류지혁~!\n최강 삼성 승리를 위해~ 류! 지! 혁!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+류지혁+응원가",
  },
  "문보경": {
    title: "문보경 응원가",
    lyrics: "(하나! 둘! 하나! 둘! 셋! 넷!)\n무적 LG 승리 위해 날려버려라~\nLG의 문보경! (안타!) LG의 문보경 (홈런!) (x2)\n오오오 문보경!\nLG의 문보경 (안타!)\nLG의 문보경\n문보경 안타를 날려라 (안타!)\n×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+문보경+응원가",
  },
  "문성주": {
    title: "문성주 응원가",
    lyrics: "무적LG 오 문성주 날려버려라~\n무적LG 오 문성주 날려버려라~\n랄랄라라 랄랄라라 랄랄랄라라~ (헤이!)\n랄랄라라 랄랄라라 랄랄랄라라~ (헤이!) (x2)\n무적 LG 문성주~ 무적 L~G 문성주~\n오오오오~ LG의 문성주\n날려버려라\n무적 LG 문성주~ 무적 L~G 문성주~\n오오오오~ LG의 문성주\n날려버려라~ 오오오오오~\n문! 성! 주!",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+문성주+응원가",
  },
  "문정빈": {
    title: "문정빈 응원가",
    lyrics: "문정빈 힘차게 날아올라봐\nLG의 승리 위하여\n문정빈 넌 빛나고 있어\n문정빈 힘차게 날아올라봐\nLG의 승리 위하여\n문정빈 주인공은 바로 너!\n문!정!빈!",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+문정빈+응원가",
  },
  "문현빈": {
    title: "문현빈 응원가",
    lyrics: "응원가 : 타이푼 - 사랑을 주세요 듣기\n한화 문현빈 워어어어어 한화 문현빈 워어어어어 최강 한화의 승리를 위해 워어어어 어어어어 (×2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+문현빈+응원가",
  },
  "박건우": {
    title: "박건우 응원가",
    lyrics: "워어어 NC 박건우 워어어 NC 박건우 언제나 거침없이 넌 달려왔지\n쎄리라 NC 박건우 쎄리라 NC 박건우 절대 멈추지 않아 승리를 향해 박건우~",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+박건우+응원가",
  },
  "박관우": {
    title: "박관우 응원가",
    lyrics: "L~G 박관우~\n무적LG의 박관우~\n무적 LG 승리 위하여\n워어어어어어~\nx2",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+박관우+응원가",
  },
  "박동원": {
    title: "박동원 응원가",
    lyrics: "저 끝~까지 날려~버려 안!방!마!님! 박!동!원!\n히어~로즈 승리~위해 안!방!마!님! 박!동!원!\n저 끝~까지 날려버려 안!방!마!님! 박!동!원!\n히어~로즈 승리~위해 안!방!마!님! 박!동!원!\n박!동!원! 박!동!원!\n박!동!원! 박!동!원!\n크라잉넛 - 필살 offside\n넥센의 안방마님 박동원~\n넥센의 안방마님 박동원~\n넥센의 안방마님 박동원~\n워어우워~ 박동원! 널 사랑해~\n마이티마우스 - 나쁜놈\n2022시즌 중 KIA로 이적했다.\n여담으로 박동원과 닮은 김광규가 광고했던 야관문 CM송 열려라 참깨로 만들어진 팬메이드 응원가가 있는데 이게 상당히 큰 반응을 끌었었다.링크\n3.1.4. 주효상(2016~2022)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+박동원+응원가",
  },
  "박명근": {
    title: "박명근 응원가",
    lyrics: "Carte Blanq & Maxx Power - 33 Max Verstappen",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+박명근+응원가",
  },
  "박민": {
    title: "박민 응원가",
    lyrics: "응원가 (이적 - 하늘을 달리다) 듣기\nKIA 타이거즈\n타이거즈의 박민 (워어어어)\n안타 홈런 날려버려 워우어\n기아 승리를 위해 달려 (박민) X2\n영원토록 달려갈거야",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+박민+응원가",
  },
  "박민우": {
    title: "박민우 응원가",
    lyrics: "오오오 NC의 박민우~ 오오오 NC의 박민우~ 오오오 NC의 박민우~ 다! 이! 노! 스! 박! 민! 우![A]\n투트랙으로 사용된다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+박민우+응원가",
  },
  "박상언": {
    title: "박상언 응원가",
    lyrics: "응원가 : 이현섭 - 내 인생의 스페셜 듣기\n한화의 박상언 워어어어 한화의 박상언 워어어어 승리의 그이름 박상언 기억해 워어어어 (×2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+박상언+응원가",
  },
  "박세웅": {
    title: "박세웅 응원가",
    lyrics: "본 조비 - It's My Life",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+박세웅+응원가",
  },
  "박수종": {
    title: "박수종 응원가",
    lyrics: "박~수 박수 박수종~ 안타 안타 박수종~\n승리를 위하여 파이팅~ 키움 히어로 박수종~\n박~수 박수 박수종~ 안타 안타 박수종~\n승리를 위하여 파이팅~ 키움 히어로 박수종~\n2.3.8. 장재영",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+박수종+응원가",
  },
  "박승규": {
    title: "박승규 응원가",
    lyrics: "안타를 펑! 펑! 펑! 오! 날려라~\n최강 삼성 박승규~\n안타를 펑! 펑! 펑! 펑!\n안타를 펑! 펑! 펑! 박승규 예~!\n안타를 펑! 펑! 펑! 오! 날려라~\n최강 삼성 박승규~\n안타를 펑! 펑! 펑! 펑!\n안타를 펑! 펑! 펑! 박승규 예~!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+박승규+응원가",
  },
  "박승욱": {
    title: "박승욱 응원가",
    lyrics: "롯데의 박승욱 안타 안타~\n롯데의 박승욱 안타 안타~\n오오오 오오오 오오오 오오오\n롯!데! 박!승!욱! ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+박승욱+응원가",
  },
  "박시원": {
    title: "박시원 응원가",
    lyrics: "다이노스 박시원~ 오오오오오오오오오오 (안! 타! 박시원!)\n다이노스 박시원~ (시원하게 쌔리라!) [A]\n2025 시즌 새롭게 공개된 응원가.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+박시원+응원가",
  },
  "박정우": {
    title: "박정우 응원가",
    lyrics: "응원가 (얀 - <Run>)\n듣기\nKIA 타이거즈\n자~달릴까 타이거즈 박정우\n워어어어어어 어어~ KIA 박정우!\n날려버려라 타이거즈 박정우\n워어어어어어 어어~ KIA 박정우!",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+박정우+응원가",
  },
  "박정현": {
    title: "박정현 응원가",
    lyrics: "응원가 : 다비치 - 안녕이라고 말하지마 듣기\n박정현 날려버려 워어어어~ 한화 승리 위하여~\n안타 날려라 홈런 날려라~ 한화 박정현~\n박정현 날려버려 워어어어~ 한화승리 위하여~\n워어 날려라 한화 박정현 ~ (x2)\n2025년 6월17일 상무에서 전역했다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+박정현+응원가",
  },
  "박주홍": {
    title: "박주홍 응원가",
    lyrics: "워~어! 워~어! 히어로즈 박주홍~\n워~어! 워~어! 히어로즈 박주홍~\n워~어! 워~어! 히어로즈 박주홍~\n워~어! 워~어! 히어로즈 박주홍~\n2.3.3. 박찬혁",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+박주홍+응원가",
  },
  "박진": {
    title: "박진 응원가",
    lyrics: "샤키라 - Try Everything",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+박진+응원가",
  },
  "박진형": {
    title: "박진형 응원가",
    lyrics: "Lil Nas X - Star Walkin'",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+박진형+응원가",
  },
  "박찬혁": {
    title: "박찬혁 응원가",
    lyrics: "히어로 박찬혁 워어어어~\n히어로 박찬혁 워어어어~\n히어로 박찬혁 워어어어~\n히어로 박찬혁 워어어어~\nRadiorama - Yeti\n2.3.4. 임병욱",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+박찬혁+응원가",
  },
  "박찬형": {
    title: "박찬형 응원가",
    lyrics: "오~ 롯데의 박찬형\n안타 안타 안타 안타\n오~ 롯데의 박찬형\n박!찬!형! X2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+박찬형+응원가",
  },
  "박해민": {
    title: "박해민 응원가",
    lyrics: "날려버려 안타 박해민\n오오오오오~ 박해민~\n무!적!L!G! 박!해!민!\n날려버려 안타 박해민\n오오오오오~ 박해민~\n무!적!L!G! 박!해!민!\n등장곡+응원가 듣기",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+박해민+응원가",
  },
  "배찬승": {
    title: "배찬승 응원가",
    lyrics: "● 잔나비 - 사랑하긴 했었나요 스쳐가는 인연이었나요 짧지않은 우리 함께했던 시간들이 자꾸 내 마음을 가둬두네",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+배찬승+응원가",
  },
  "백승현": {
    title: "백승현 응원가",
    lyrics: "미란이,먼치맨,쿤디판다,머쉬베놈 - VVS(feat.JUSTHIS) (Prod.GroovyRoom)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+백승현+응원가",
  },
  "백정현": {
    title: "백정현 응원가",
    lyrics: "● Fort Minor - Remember The Name",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+백정현+응원가",
  },
  "변우혁": {
    title: "변우혁 응원가",
    lyrics: "듣기\nKIA 타이거즈\nBet you didn't think that I'd come back to life\nStronger (Stronger, Stronger, Stronger, Stronger)\n변우혁! (Bet you didn't think that I'd come back to life)\nStronger (Stronger, Stronger, Stronger, Stronger)\n변우혁! (Bet you didn't think that I'd come back to life)\n응원가 (Alan Walker - The Drum)\n듣기\nKIA 타이거즈\n타이거즈의 변우혁 안타\n날려버려라 변우혁 홈런\n타이거즈의 변우혁 안타\n날려버려라 변우혁 홈런\n날려버려라 워워우워워\n변우혁 안타 워워우워워\n날려버려라 워워우워워\n변우혁 홈런 워워우워워",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+변우혁+응원가",
  },
  "서호철": {
    title: "서호철 응원가",
    lyrics: "다이노스 서호철 워어어 워어~ 안! 타! 다이노스 서호철 승리를 위해~ 안! 타![A]",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+서호철+응원가",
  },
  "손성빈": {
    title: "손성빈 응원가",
    lyrics: "최강롯데 자이언츠 롯데 손성빈\n안타 손성빈 안타 손성빈\n오오오오~ 오오~ 손!성!빈! ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+손성빈+응원가",
  },
  "손아섭": {
    title: "손아섭 응원가",
    lyrics: "오! 다이노스 손아섭 NC 승리 위해! 오! 오오오~ 다! 이! 노! 스! 손! 아! 섭! [A]\n여담으로 응원가 공개 당시 엔튜브 제작진이 손아섭을 속이기 위해 가짜 응원가를 공개했는데, 이를 들은 손아섭은 자신이 아는 응원가가 아닌 다른 응원가가 나오자 당황했으나, 이내 긍정적인 반응을 보였으며 이후 가짜 응원가인 걸 알고는 안심하기도 했다. 가짜 응원가\n2025 시즌 도중 한화 이글스로 트레이드 되었다. 그리고 응원가 역시 함께 한화로 넘어갔다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+손아섭+응원가",
  },
  "손주영": {
    title: "손주영 응원가",
    lyrics: "The Score - Legend",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+손주영+응원가",
  },
  "손호영": {
    title: "손호영 응원가",
    lyrics: "롯데의 손호영 안타 쌔리라\n롯데의 손호영 오오오오 ×4",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+손호영+응원가",
  },
  "송승기": {
    title: "송승기 응원가",
    lyrics: "f(x) - Electric Shock",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+송승기+응원가",
  },
  "송찬의": {
    title: "송찬의 응원가",
    lyrics: "LG의 송찬의(안타!)~ LG의 송찬의(홈런!)~\n무적LG 승리위해 날려버려라~ (x2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+송찬의+응원가",
  },
  "신민재": {
    title: "신민재 응원가",
    lyrics: "날려버려~ 날려버려~ 안!타!신!민!재!(×4)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+신민재+응원가",
  },
  "신윤후": {
    title: "신윤후 응원가",
    lyrics: "롯데 신윤후~ 롯데 신윤후~\n안타 안타 오오오오~ ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+신윤후+응원가",
  },
  "심우준": {
    title: "심우준 응원가",
    lyrics: "응원가 : 페퍼톤스 - Superfantastic 듣기\n한화 심우준~ 한화 심우준~ 오오오 이글스의 심우준~ 한화 심우준~ 한화 심우준~ 오오오 너는 슈퍼 판타스틱~",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+심우준+응원가",
  },
  "심재훈": {
    title: "심재훈 응원가",
    lyrics: "삼성의 심재훈~ 삼성의 심재훈~\n안타를 날! 려! 버! 려! 삼성 심재훈~\n삼성의 심재훈~ 삼성의 심재훈~\n홈런을 날! 려! 버! 려! 삼성 심재훈~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+심재훈+응원가",
  },
  "안재석": {
    title: "안재석 응원가",
    lyrics: "김연자 - GOGO (2022~)\nGO! GO! 두산의 안~ 재석! GO! GO! 힘차게 달~ 려라! GO! GO! 승리를 위하여! 워어어~ 안! 재! 석!(×2)\n3. 은퇴, 이적 선수\n[롯데] 최준석 응원가 (2007~2013)\n날려라 준! 날려라 석! 날려라 최준석~ 홈런! [X4]\n[넥센] 윤석민 응원가 (2012~2013)\n최강베어스 두산 윤~ 석민~ 오오오오오오오~ 홈런을 날~ 려줘~ 최강베어스 두산 윤~ 석민~ 날려라 두산 윤석민 승리를 위하여~ [X2]\n[은퇴] 김동주 응원가 (1998~2014)\n동~주 동주 김동주~ (Hey!) 김동주~ (Hey!) 김동주~ (Hey!) 동~주 동주 김동주~ (Hey!) 홈런 김동주~ (홈런!)\n[방출] 칸투 응원가 (2014)\n칸~ 투! 오~ 오오오오오오오오~ [X2] 칸~ 투!\n[방출] 루츠 응원가 (2015)\n두! 산! 의! 잭 루츠! 워어어어어~ 두산의 잭 루츠! 워어어어어~ 두산의 잭 루츠! 워어어어어~ 최강두! 산 잭! 루! 츠! [X2]\n[방출] 로메로 응원가 (2015)\n로~ 메로 로메로 로메로 로메~ 로 안타! 로~ 메로 로메로 로메로 로메~ 로 홈런! 날~ 려라 로메로 날~ 려라 로메로 날~ 려라 로메로 로! 메! 로! [X2]\n[kt] 김현수 응원가 (2008~2015)\n홈! 런! 김현수! 나나 나나나 나나나 나나나 나나 나나나 (O번 타자 누구!) 김현수! x3\n[키움] 이원석 응원가\n두산의 이원석! 오오오오오오오~ 두산의 이원석! 오오오오오오오~! 두산의 이원석! 날려라~ 두산 이원석~ [X2]\n[은퇴] 홍성흔 응원가 (2013~2016)\n홍~ 성~ 흔~ 홍~ 성~ 흔~ 파이팅! 두산의 홍성흔~ [X2]\n[은퇴] 고영민 응원가 (2007~2016)\n고젯! 안타! [X3]\n[한화] 최재훈 응원가\n최강두산 최~ 재훈~ 최! 강! 두! 산! 최! 재! 훈! [X2]\n[방출] 에반스 응원가 (2016~2017)\n최! 강! 두! 산! 에! 반! 스! 에에에 에에에 에에 에반스! 에에에 에에에 에에 에반스! 에에에 에에에 에에 에반스! [X2] 최! 강! 두! 산! 에! 반! 스!\n[은퇴] 민병헌 응원가 (2017)\n허니~ 허니~ 민병허니~ 안~ 타~ 민병헌! [X4]\n[방출] 파레디스 응원가 (2018)\n파~ 레디스~ 두산의 파~ 레디스~ 오오오오~ 두산의 파~ 레~ 디스~ [X2]\n[방출] 반 슬라이크 응원가 (2018)\n최! 강! 두산의! 반 슬라이크! 안타! 최강! 두산의! 반 슬라이크! 홈런! 워~ 우워~ 반 슬라이크! 안타! 워~ 우워~ 반슬라이크! 홈런!\n[은퇴] 정진호 응원가\n안~ 타~ 정진~ 호! 안타 정진호~! 안~ 타~ 정진~ 호! 안타 정진호! 안타! [X2]\n[은퇴] 정상호 응원가 (2020)\n안~ 타~ 정상~ 호! 안타 정상호~! 안~ 타~ 정상~ 호! 안타 정상호! 안타! [X2]\n[삼성] 류지혁 응원가\n류! 지혁이가 안타를 친다! 류! 지혁이가 안타를 친다! 류! 지혁이가 안타를 친다! 안타! 류! 지! 혁! [X2]\n[키움] 최주환 응원가\n안타 안타~ 날려버려 오오오~ 두산~ 의 최주~ 환~ 최강두산 최주~ 환 오오오~ 두산~ 의 최~ 주환~! [X2]\n[kt] 오재일 응원가 (2017~2020)\n오~ 재일! 오~ 오! 재! 일! 오오오오오오~ 두산의 오재일~ 오! 재! 일! [x2]\n[NC] 박건우 응원가 (2017~2021)\n안타 박건우 오오오! 안타 박건우 오오오! 안타 박건우 오오오! 최! 강! 두! 산! 박건우! [X2]\n[방출] 국해성 응원가\n오! 두산의 국해성! 오! 두산의 국해성! 오! 두산의 국해성! 오~ 오오오~ [X2]\n[은퇴] 오재원 응원가 (2008~2022)\n오! 재원이 안타 날려버려 오! 재원이 안타 날려버려 오! 재원이 안타 날려버려 예! 예! [X2]",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+안재석+응원가",
  },
  "안중열": {
    title: "안중열 응원가",
    lyrics: "다이노스 안중열~ 거침없이 가자 가자 안~중열~ (안중열 안타!)\n다이노스 안중열~ 거침없이 안타 안타 안~중열~ (안중열 안타!)[A]",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+안중열+응원가",
  },
  "양석환": {
    title: "양석환 응원가",
    lyrics: "최강두산 양석환 안타날려라!~\n최강두산 양석환 홈런날려라!~\n워어어어어↗ 양석환~ 워어어어어→ 양석환~\n워어어어어↗ 양석환~ 워우워어~ 양! 석! 환!\n2024년부터 새롭게 사용 중인 응원가.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+양석환+응원가",
  },
  "양우현": {
    title: "양우현 응원가",
    lyrics: "삼성의 양우현 삼성의 양우현\n오오오 최강삼성 양우현\n삼성의 양우현 삼성의 양우현\n야이야이야이야이야~\n삼성의 양우현 삼성의 양우현\n오오오 최강삼성 양우현\n삼성의 양우현 삼성의 양우현\n야이야이야이야이야~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+양우현+응원가",
  },
  "양의지": {
    title: "양의지 응원가",
    lyrics: "양의지 다이노스 양의지 승리를 위하여 오오오 다이노스 양의지[A]\n양! 의! 지!\n투트랙으로 사용되었다.\n2023년 친정팀인 두산 베어스로 돌아갔다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+양의지+응원가",
  },
  "양창섭": {
    title: "양창섭 응원가",
    lyrics: "● 박효신 -Home",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+양창섭+응원가",
  },
  "양현": {
    title: "양현 응원가",
    lyrics: "● Lady Gaga - Poker Face",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+양현+응원가",
  },
  "양현종": {
    title: "양현종 응원가",
    lyrics: "듣기\nKIA 타이거즈\nHm, after all you put me through\nYou think I despise you.\nBut in the end, I wanna thank you\nCuz you made me that much stronger\nWhen I thought I knew you\nThinkin' that you were true Guess I, I couldn't trust\nCaught your bluff\nTime is up cuz I've had enough\nYou were there by my side\nAlways down for the ride...but your\nJoyride just came down in flames\nCuz you greed sold me out to shame\nAfter all of the stealing and cheating\nYou probably think that I hold resentment for you\nBut uh uh\nNo no..you're wrong\nSee if it wasn't for all that you tried to do\nI wouldn't know just how capable\nI am to pull through so I wanna say thank you\nCuz it makes me that much stronger\nMakes me work a little bit harder\nMakes me that much wiser\nSo thanks for making me a fighter\nMade me learn a little bit faster\nMade my skin a little bit thicker\nMade me that much smarter\nThanks for making me a fighter\n[이전 등장곡, 응원가 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+양현종+응원가",
  },
  "여동욱": {
    title: "여동욱 응원가",
    lyrics: "히어로즈의 여동욱 히어로즈의 여동욱\n승리를 위하여 움직여라 오오 여동욱\n히어로즈의 여동욱 히어로즈의 여동욱\n승리를 위하여 큰거한방 오오 여동욱\n2.2.7. 전태현",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+여동욱+응원가",
  },
  "오명진": {
    title: "오명진 응원가",
    lyrics: "최강두산! 오명진! 안타를 날려라~\n최강두산! 오명진! 홈런을 날려라~\n최강두산! 오명진! 안타를 날려라~\n최강두산 오!명진~\n제러드 영의 응원가를 재사용한다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+오명진+응원가",
  },
  "오선우": {
    title: "오선우 응원가",
    lyrics: "응원가 (TUBE - The Season In The Sun)\n듣기\nKIA 타이거즈\n오오 기아 오선우 나나나나~\n안타 날려라 홈런 날려라 승리를 위해\n오오 기아 오선우 나나나나~\n타이거즈 승리를 위해 워우워우 오!선!우!",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+오선우+응원가",
  },
  "오선진": {
    title: "오선진 응원가",
    lyrics: "오! 오선진 히어로즈 오선진\n오오 오오오오 날! 려! 버! 려! 오선진!\n오! 오선진 히어로즈 오선진\n오오 오오오오 날! 려! 버! 려! 오선진!\n2.2.9. 서건창",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+오선진+응원가",
  },
  "오스틴 딘": {
    title: "오스틴 딘 응원가",
    lyrics: "무적LG의 오스틴 딘! 날려버려라 오! 스! 틴! 딘! X4\n안타나 홈런시: 구단 자작곡 듣기\n오스틴 딘 오오오~ 오스틴 딘 오오오~ 오스틴 딘 오오오~ 오!스!틴! 딘! ×4",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+오스틴 딘+응원가",
  },
  "오영수": {
    title: "오영수 응원가",
    lyrics: "오! 오영수 NC 다이노스 오영수\n안타를 (쌔리라!) 홈런을 (쌔리라!) 다! 이! 노! 스! 오! 영! 수! [A]",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+오영수+응원가",
  },
  "오지환": {
    title: "오지환 응원가",
    lyrics: "무적 LG 오지환~\n무적 LG 오지환~\n워어어어어어어~\n(누구?)\n무!적!L!G! 오!지!환!\n무적 LG 오지환~\n무적 LG 오지환~\n워어어어어어어~\n(누구?)\n무!적!L!G! 오!지!환!",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+오지환+응원가",
  },
  "우강훈": {
    title: "우강훈 응원가",
    lyrics: "Guns N’ Roses - Sweet Child O’ Mine",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+우강훈+응원가",
  },
  "원성준": {
    title: "원성준 응원가",
    lyrics: "오오 키움 원성준 키움 원성준\n날아 날아올라 오오오오 키움 원성준 승리를 위해\n오오 키움 원성준 키움 원성준\n날아 날아올라 오오오오 키움 원성준 승리를 위해\n모종의 이유로 현재 미사용 중이다.\n3. 은퇴/이적 선수\n3.1. 포수\n3.1.1. 허도환(2011~2015)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+원성준+응원가",
  },
  "유강남": {
    title: "유강남 응원가",
    lyrics: "롯데의 유강남 오오오~ (유!강!남!)\n롯데의 유강남 오~ 오오오~ ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+유강남+응원가",
  },
  "유영찬": {
    title: "유영찬 응원가",
    lyrics: "SHINee - Sherlock.셜록 (Clue+Note)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+유영찬+응원가",
  },
  "윤도현": {
    title: "윤도현 응원가",
    lyrics: "응원가 (FIELD OF VIEW - DAN DAN 心魅かれてく)\n듣기\nKIA 타이거즈\n안!타! 최강 KIA 윤~도현\n홈!런! 타이거즈 윤~도현\n승리를 위하여 오오오오 오오 오오~\n안!타! 최강 KIA 윤~도현\n홈!런! 타이거즈 윤~도현\n승리를 위하여 오오오오 오오 오오~",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+윤도현+응원가",
  },
  "윤동희": {
    title: "윤동희 응원가",
    lyrics: "롯데의 (Hey!) 윤동희~ 쌔리라 안타 쌔리라~\n최강롯데 자이언츠 윤동희~ (안타!) X2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+윤동희+응원가",
  },
  "윤정빈": {
    title: "윤정빈 응원가",
    lyrics: "오오오오 윤정빈\n삼성의 윤정빈 오오오\n오오오오 윤정빈\n삼성의 승리를 위해\n오오오오 윤정빈\n삼성의 윤정빈 오오오\n오오오오 윤정빈\n삼성의 승리를 위해",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+윤정빈+응원가",
  },
  "이도윤": {
    title: "이도윤 응원가",
    lyrics: "응원가 : 타카피 - Let it Rain 듣기\n한화의(의!) 이도윤(윤!) 워어어어어어어 힘차게 날려라 승리를 위하여 한화의(의!) 이도윤(윤!) 워어어어어어어 힘차게 날려라 이도윤 (이!도!윤!) (×2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+이도윤+응원가",
  },
  "이민석": {
    title: "이민석 응원가",
    lyrics: "콜드플레이 - Viva La Vida",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+이민석+응원가",
  },
  "이민호": {
    title: "이민호 응원가",
    lyrics: "T-MAX - 파라다이스\n3. 상무 피닉스 소속 군입대 선수\n3.1. 타자 등장곡 및 응원가\n3.1.1. 김범석\nLG의 김범석\nLG의 김범석\nLG의 승리를 위하여\n날려라 김범석 ×2\n3.1.2. 김성우",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이민호+응원가",
  },
  "이병헌": {
    title: "이병헌 응원가",
    lyrics: "이병헌 삼성의 승리를 위해!\n안타를 날려버려 오오오!\n이병헌 삼성의 승리를 위해!\n날려버려 이병허니~\n이병헌 삼성의 승리를 위해!\n안타를 날려버려 오오오!\n이병헌 삼성의 승리를 위해!\n날려버려 이병허니~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+이병헌+응원가",
  },
  "이성규": {
    title: "이성규 응원가",
    lyrics: "날려라 삼성 이성규~ 오~ 안타!\n삼성 이성규~ 오~ 홈런!\n최강 삼성 승리 위해!\n날려라 삼성 이성규~ 오~ 파이팅!\n날려라 삼성 이성규~ 오~ 안타!\n삼성 이성규~ 오~ 홈런!\n최강 삼성 승리 위해!\n날려라 삼성 이성규~ 오~ 파이팅!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+이성규+응원가",
  },
  "이승민": {
    title: "이승민 응원가",
    lyrics: "● G-DRAGON - HOME SWEET HOME(Feat.태양,대성)",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+이승민+응원가",
  },
  "이영빈": {
    title: "이영빈 응원가",
    lyrics: "달려라 LG의 이영빈~\n날려라 LG의 이영빈~\nLG의 승리를 위하여~\n오! 이영빈~\n×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이영빈+응원가",
  },
  "이우성": {
    title: "이우성 응원가",
    lyrics: "다이노스 이우성 승리위해 날려라 우리들의 별이 되어 오 이우성[A]\n안! 타! 이우성! 홈! 런! 이우성!\n2025 시즌 새롭게 공개된 응원가.\n원래 한 키 더 높았으나 혹평이 심해 내렸다.\n2. 추억의 응원가\n과거 NC 소속이었으나 선수가 은퇴, 이적을 하거나 기타 사유로 인해 더 이상 사용하지 않는 응원가들이다.\n2.1. 포수",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+이우성+응원가",
  },
  "이유찬": {
    title: "이유찬 응원가",
    lyrics: "찬란하게 빛날 최강두산 이유찬~ (이유찬!)\n힘차게 날아올라라! 최강두산 이유찬! [X2]\n응원가가 낭만 있다는 사람들이 많다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+이유찬+응원가",
  },
  "이재상": {
    title: "이재상 응원가",
    lyrics: "히어로즈 이재상 히어로즈 이재상\n승리를 위해 치고 달려라 히어로 이재상 워어\n히어로즈 이재상 히어로즈 이재상\n승리를 위해 치고 달려라 히어로 이재상\n모종의 이유로 현재 미사용 중이다.\n2.3. 외야수\n2.3.1. 이용규",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+이재상+응원가",
  },
  "이재원": {
    title: "이재원 응원가",
    lyrics: "응원가 : 루트비히 판 베토벤 - Für Elise 듣기\n이글스의 이재원 오오오 오오오오 이글스의 이재원 오오오 오오오오 이재원 오오오오 오오오오 오오오오 이글스의 이재원 오오오 오오오오 이!재!원!\nSSG 시절 응원가를 팀명만 바꿔 쓰고 있다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+이재원+응원가",
  },
  "이정용": {
    title: "이정용 응원가",
    lyrics: "Imagine Dragons - Believer",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이정용+응원가",
  },
  "이정훈": {
    title: "이정훈 응원가",
    lyrics: "롯~데 롯데 이정훈 안타~\n오~오오 (HEY!) 오~오오 (HEY!)\n롯~데 롯데 이정훈 안타~\n롯!데! 이!정!훈! X2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+이정훈+응원가",
  },
  "이종준": {
    title: "이종준 응원가",
    lyrics: "AJR - Burn The House Down",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이종준+응원가",
  },
  "이주헌": {
    title: "이주헌 응원가",
    lyrics: "트윈스 이주헌 날려버려라\n날려버려라 날려버려라\n트윈스 이주헌 날려버려라\nLG 트윈스의 주헌이 (안타!) (X2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이주헌+응원가",
  },
  "이주형": {
    title: "이주형 응원가",
    lyrics: "이주형 워어어 이주형 워어어\n저 높이 날아올라 빛이 되리라 히어로즈 이주형\n이주형 워어어 이주형 워어어\n저 높이 날아올라 빛이 되리라 히어로즈 이주형\n2.3.7. 박수종",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+이주형+응원가",
  },
  "이지강": {
    title: "이지강 응원가",
    lyrics: "비 - Rainism",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+이지강+응원가",
  },
  "이진영": {
    title: "이진영 응원가",
    lyrics: "응원가 : 트랜스 픽션 - 불의전차 듣기\n한화의 이진영 워어어 한화의 이진영 워어어 이순간 너의 모든것을 보여줘 넌! 이진영이다 (×2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+이진영+응원가",
  },
  "이창용": {
    title: "이창용 응원가",
    lyrics: "게오르크 프리드리히 헨델 - Laudate Dominum'(주 찬미하라)\n오! 이~창용~\n최강삼성 이창용~\n라이온즈 승리 위!하!여!\n안타 이~창용~\n오! 이~창용~\n최강삼성 이창용~\n라이온즈 승리 위!하!여!\n안타 이~창용~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+이창용+응원가",
  },
  "이창진": {
    title: "이창진 응원가",
    lyrics: "응원가 (WEPLAY - We)\n듣기\nKIA 타이거즈\n안~ 타 워어 KIA 이창진\n홈~런 워어 KIA 이창진\n승리를 위해 다같이 외쳐 KIA! 이창진!\n[이전 등장곡 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+이창진+응원가",
  },
  "이형종": {
    title: "이형종 응원가",
    lyrics: "히어로즈 이~형종 워어어 워어어어\n히어로즈 이~형종 워어어 워어어어\n히어로즈 이~형종 워어어 워어어어\n히어로즈 이~형종 워어어 워어어어\n2.3.6. 이주형",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+이형종+응원가",
  },
  "이호성": {
    title: "이호성 응원가",
    lyrics: "● TULA - 에반게리온OP '잔혹한 천사의 테제'",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+이호성+응원가",
  },
  "임병욱": {
    title: "임병욱 응원가",
    lyrics: "임~병욱 (짝짝짝짝) 임~병욱 (짝짝짝짝)\n히어로즈의 승리를 위하여 하나되어 외쳐보자 (짝짝짝짝)\n임~병욱 (짝짝짝짝) 임~병욱 (짝짝짝짝)\n히어로즈의 승리를 위하여 하나되어 외쳐보자 (짝짝짝짝)\n2.3.5. 이형종",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+임병욱+응원가",
  },
  "임종찬": {
    title: "임종찬 응원가",
    lyrics: "응원가 : 구단 자작곡 듣기\n오 임종찬 짝짝 오 임종찬 짝짝 찬찬찬 한화 임종찬 로컬보이 워 워워 한화 임종찬 (x2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+임종찬+응원가",
  },
  "임지열": {
    title: "임지열 응원가",
    lyrics: "히어로즈 임지열 히어로즈 임지열\n히어로즈 VAMOS 임지열 워어어어어\n히어로즈 임지열 히어로즈 임지열\n히어로즈 VAMOS 임지열 워어어어어\n2.2.4. 최주환",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+임지열+응원가",
  },
  "임찬규": {
    title: "임찬규 응원가",
    lyrics: "보아 - No.1\n원더걸스 - Tell me\nKSHMR & Zafrir - Winners Anthem",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+임찬규+응원가",
  },
  "장두성": {
    title: "장두성 응원가",
    lyrics: "롯데 롯데 장두성~ 롯데의 장두성~\n롯데 롯데 장두성~ 오 오오 오오오오~ 안타! x2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+장두성+응원가",
  },
  "장승현": {
    title: "장승현 응원가",
    lyrics: "오오오 두~ 산의 장승현~!\n오오오 두~ 산의 장승현~!\n힘차게 날~ 려라~ 오 장~ 승현~\n오오오 두~ 산의 장승현~!\n2025 시즌 이후 삼성 라이온즈로 이적하였다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+장승현+응원가",
  },
  "장현식": {
    title: "장현식 응원가",
    lyrics: "DAY6 - Welcome to the Show",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+장현식+응원가",
  },
  "전민재": {
    title: "전민재 응원가",
    lyrics: "롯데의 전민재~ 롯데의 전민재 안타~\n오오오오 오 오오 오 롯데 전민재~ (전민재!)\n전민재~ 롯데의 전민재 안타~\n오오오오 오 오오 오 롯데 전민재~ (전민재!)",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+전민재+응원가",
  },
  "전병우": {
    title: "전병우 응원가",
    lyrics: "워어어어어 히어로즈 전병우\n승리를 위하여 히어로즈 전!병!우!\n워어어어어 히어로즈 전병우\n승리를 위하여 히어로즈 전!병!우!\n2023년 11월 22일 실행한 2차 드래프트에 지명되어 삼성 라이온즈로 이적했다.\n3.2.14. 김휘집(2021~2024)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+전병우+응원가",
  },
  "전준우": {
    title: "전준우 응원가",
    lyrics: "안타 안타 쌔리라 쌔리라\n롯데 전준우~ ×4",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+전준우+응원가",
  },
  "정보근": {
    title: "정보근 응원가",
    lyrics: "롯데 자이언츠 정보근 (Hey!)\n롯데 자이언츠 정보근 (Hey!)\n롯데 자이언츠 정보근 (Hey!)\n오 오오 오오오~ ×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+정보근+응원가",
  },
  "정수빈": {
    title: "정수빈 응원가",
    lyrics: "수빈! 두산의 정수빈~ 수빈! 승리를 위하여~\n수빈! 힘차게 치고 달려~ 최강두산 정수빈! [X2]\n2010년 부터 사용하던 응원가가 큰 인기를 끌었으나 군 입대 기간 도중인 2017년 터진 대규모 저작권 문제로 사용이 중단됐고, 2018년 경찰청에서 전역한 이후 이 응원가를 쓰고 있다. 한재권 단장이 뒷 가사는 신경쓰지 말고 수빈!만 아무튼 크게 외치라고 유도하는 사례가 종종 있으며, 한 번은 예전 정수빈의 응원가처럼 이 응원가도 남녀 파트를 분배하도록 유도한 적이 있다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+정수빈+응원가",
  },
  "정우영": {
    title: "정우영 응원가",
    lyrics: "드렁큰 타이거 - 몬스터",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+정우영+응원가",
  },
  "정철원": {
    title: "정철원 응원가",
    lyrics: "젝스키스 - 사나이 가는 길 (폼생폼사)",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+정철원+응원가",
  },
  "조민성": {
    title: "조민성 응원가",
    lyrics: "삼성의 조민성~(안타!)\n조민성~(홈런!)\n조민성~(누구?)\n삼성의 조민성~ 조민성~ 워워워어~\n삼성의 조민성~(안타!)\n조민성~(홈런!)\n조민성~(누구?)\n삼성의 조민성~ 조민성~ 워워워어~",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+조민성+응원가",
  },
  "조세진": {
    title: "조세진 응원가",
    lyrics: "조세진\n오 오오 오오 오오오~\n오 롯데 롯데 조세진~\n오 오오 오오 오오오~\n오 롯데 롯데 조세진~ x2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+조세진+응원가",
  },
  "조수행": {
    title: "조수행 응원가",
    lyrics: "사일런트 파트너 - Marvin's Dance (2018~)\n조수행! 조수행! 조수행! 조수행! 안타치고 도루하고 라라라라 라라라라라! 조! 수! 행! [X2]\n상당히 중독성이 있는 응원가로, 두산 팬들 뿐만 아니라 타팀 팬들에게도 인기가 많다.\n검정고무신 OST(정확하게는 오프닝)와 비슷하다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+조수행+응원가",
  },
  "주성원": {
    title: "주성원 응원가",
    lyrics: "히어로 주성원 힘차게 날려버려라\n히어로즈 파워히터 주성원\n히어로 주성원 힘차게 날려버려라\n히어로즈 승리를 위해\n히어로 주성원 힘차게 날려버려라\n히어로즈 파워히터 주성원\n히어로 주성원 힘차게 날려버려라\n히어로즈 승리를 위해\n모종의 이유로 현재 미사용 중이다.\n2.3.10. 원성준(미사용)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+주성원+응원가",
  },
  "주효상": {
    title: "주효상 응원가",
    lyrics: "히어로즈 오 주효상 날려버려 주효사아앙\n히어로즈 오 주효상 날려버려 주효상\n안타안타 날려줘요 (주효상!)\n안타안타 날려줘요 (주효상!)\n안타안타 날려줘요 (주효상!)\n안타안타 날려줘요 (주효상!)\n스위스 민요 - 아름다운 베르네 산골\n2022시즌 후 KIA로 이적했다.\n3.1.5. 이지영(2019~2023)",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+주효상+응원가",
  },
  "진우영": {
    title: "진우영 응원가",
    lyrics: "Daddy Yankee, Pitbull - HOT",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+진우영+응원가",
  },
  "채은성": {
    title: "채은성 응원가",
    lyrics: "응원가 : 트랜스픽션 - Devilman 듣기\n최강한화 채은성 워어어어~ 최강한화 채은성 워어어어~ 저!하늘로 날아올라 빛이 되리라 워어어어 한화 채은성 (x2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+채은성+응원가",
  },
  "최원영": {
    title: "최원영 응원가",
    lyrics: "오 LG의 최원영 끝~까지\n오 LG의 최원영 할!수!있!어!최!원!영! (X2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+최원영+응원가",
  },
  "최원준": {
    title: "최원준 응원가",
    lyrics: "오오오 최원준~ 다이노스 최원준 안타~ 우리들의 승리 위해 치고 달려라~\n오오오 최원준 다이노스 최원준~ (안타! 안타!) 오 최원준~[A]\n2025 시즌 새롭게 공개된 응원가. 원래 한 키 더 높았으나 혹평이 심해 내렸다.\n최원준이 11월 25일 기준 kt wiz로 이적함에 따라 고작 1개월 반 정도 사용하고 단명한 비운의 응원가가 되었다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+최원준+응원가",
  },
  "최이준": {
    title: "최이준 응원가",
    lyrics: "Panic At the Disco - High Hopes",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+최이준+응원가",
  },
  "최인호": {
    title: "최인호 응원가",
    lyrics: "응원가 : Sun Stroke Project & Oila Tira - Run Away 듣기\n호! 안타 최인호 안타 최인호 워어어어 이글스의 호! 안타 최인호 안타 최인호 워어어어 이글스의 (X2) 최!인!호!",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+최인호+응원가",
  },
  "최정원": {
    title: "최정원 응원가",
    lyrics: "다이노스 NC 최정원 안타 안타 날려버려 다이노스 NC 최정원 안타 오오오[A]\n최! 정! 원!\n최초 공개돼있던 가사는 다이노스가 아닌 아기공룡 이었지만, 최정원이 상무에서 제대한 뒤에 다이노스로 수정되었다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+최정원+응원가",
  },
  "최주환": {
    title: "최주환 응원가",
    lyrics: "최주환 히어로즈의 최주환 안타 날려버려 워어어~\n최주환 히어로즈의 최주환 안타 날려버려 워어어~\n최주환 히어로즈의 최주환 안타 날려버려 워어어~\n최주환 히어로즈의 최주환 안타 날려버려 워어어~\n심신 - 오직 하나 뿐인 그대\n2.2.5. 고영우",
    youtubeUrl: "https://www.youtube.com/results?search_query=키움+최주환+응원가",
  },
  "최준용": {
    title: "최준용 응원가",
    lyrics: "Hugh Jackman, Keala Sattle, Zac Efron, Zendaya, The Greatest Showman Ensemble - The Greatest Show",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+최준용+응원가",
  },
  "최지광": {
    title: "최지광 응원가",
    lyrics: "● SEVENTEEN(세븐틴) - 박수",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+최지광+응원가",
  },
  "최하늘": {
    title: "최하늘 응원가",
    lyrics: "● AC/DC - Hells Bells",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+최하늘+응원가",
  },
  "톨허스트": {
    title: "톨허스트 응원가",
    lyrics: "Travis Scott - Kick Out",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+톨허스트+응원가",
  },
  "하주석": {
    title: "하주석 응원가",
    lyrics: "응원가 : 구단 자작곡 듣기\n하주석 유후! 하주석 승리를 위해~ 함께 외쳐라!\n하주석 유후! 하주석 승리를 위해~ 함께 외쳐라 워어\n하!주!석!\n응원가1 : 자우림 - 하하하쏭\n하!하!하!하! 하주~석~ 한화~의 하주~석 하!하!하!하! 하주~석 승리~의 하주~석!\n응원가2 : The Official 2014 FIFA World Cup Anthem - Dar Um Jeito (We Will Find a Way)\n하주석~워어어어어~하주석~워어어어어~하주석~워어어어어~하주석~승리를 위해! (x2)",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+하주석+응원가",
  },
  "한동희": {
    title: "한동희 응원가",
    lyrics: "롯데의 (짝짝) 한동희~ (짝짝)\n안타 안타 한동희~ (짝짝짝)[원본]\n롯데의 (짝짝) 한동희~ (짝짝)\n오오 오오오오오~ (짝짝짝)[원본] ×2\n3. 이전 응원가\n은퇴, 이적, 방출, 투타 변경 등의 이유로 쓰이지 않는 응원가\n3.1. 투수\n3.1.1. 김성배\n김성배\n김성배 김성배 화이팅!\n롯데 자이언츠 김성배~ x2",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+한동희+응원가",
  },
  "한석현": {
    title: "한석현 응원가",
    lyrics: "NC 한석현 NC 한석현 NC 한석현 거침없이 가! 자! NC 한석현 NC 한석현 NC 한석현 승리위해 안! 타!\nNC 한석현 NC 한석현 NC 한석현 오오오오 안! 타! NC 한석현 NC 한석현 NC 한석현 다이노스 한! 석! 현!",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+한석현+응원가",
  },
  "한준수": {
    title: "한준수 응원가",
    lyrics: "응원가(KSHMR & 7 Skies - Neverland)\n듣기\nKIA 타이거즈\n기아의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\nKIA의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\nKIA의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\nKIA의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\n국가대표\n한국의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\n한국의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\n한국의 한준수 워어어 어어어어\n날려라 한준수 워어어어어\n한국의 한준수 워어어 어어어어\n날려라 한준수 워어어어어",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+한준수+응원가",
  },
  "허경민": {
    title: "허경민 응원가",
    lyrics: "승리~를 위해 힘차게 날려라~ 오오~ 오오오~오오오~ 허경민~\n승리~를 위해 힘차게 날려라~ 오오~ 오오오~ 오~ 두!산! 허!경!민!\n예전 신성현의 응원가를 재활용한 것으로, 2024시즌부터 사용 중이다. 허경민 본인이 직접 요청해서 바꾼 거라고. 처음 사용하던 김건모의 '뻐꾸기 둥지 위로 날아간 새'를 개사한 응원가의 평이 좋았으나 저작권 문제로 사용이 중단됐고, 이후 B1A4의 '이게 무슨 일이야'를 개사한 응원가를 오랜 시간 썼었다.\n2024시즌 이후 kt wiz로 이적하였다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=두산+허경민+응원가",
  },
  "허인서": {
    title: "허인서 응원가",
    lyrics: "등장곡 : 지코 - 괴짜",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+허인서+응원가",
  },
  "허준혁": {
    title: "허준혁 응원가",
    lyrics: "Stellar - Ashes",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+허준혁+응원가",
  },
  "홍원표": {
    title: "홍원표 응원가",
    lyrics: "● 하현상 - 불꽃놀이",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+홍원표+응원가",
  },
  "홍종표": {
    title: "홍종표 응원가",
    lyrics: "다이노스! 홍종표 꿈을 향해서~ 다이노스 홍종표 치고 달려라 홍종표! 홍종표!\n꿈을 향해 달려라~ (다이노스 홍종표!)[A]\n2025 시즌 새롭게 공개된 응원가.\n원래 한 키 더 높았으나 혹평이 심해 내렸다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=NC+홍종표+응원가",
  },
  "홍창기": {
    title: "홍창기 응원가",
    lyrics: "홍창기 안타 안타날려 홍창기~ 홍창기 안타 날려버려라~\n홍창기 안타 안타날려 홍 창기~ 무적 LG의 승리를 위해~\n×2",
    youtubeUrl: "https://www.youtube.com/results?search_query=LG+홍창기+응원가",
  },
  "황대인": {
    title: "황대인 응원가",
    lyrics: "듣기\nKIA 타이거즈\nStart a tiny riot\nStop being so goddamn quiet\nGot a spark in your heart so strike it\nCrush your way up here\nTurn the pouring rain to a tidal wave\nAnd fight it Got something inside, don't hide it\nLike dynamite ignitin'\nCrush your way up here\nTurn the pouring rain to the wave\nOf a tiny riot\n응원가 (구단 자작곡)\n듣기\nKIA 타이거즈\n안타를 날려라 홈런을 날려라\n오오오~ KIA 타이거즈 황대인\n승리를 위하여 다함께 외쳐라\n안타! 홈런! 황!대!인! ×2\n[이전 등장곡, 응원가 보기]",
    youtubeUrl: "https://www.youtube.com/results?search_query=KIA+황대인+응원가",
  },
  "황성빈": {
    title: "황성빈 응원가",
    lyrics: "(롯!데! 황!성!빈!)\n롯~데의 황성빈! 오오오 롯~데의 황성빈!\n오오오 오~오오 오~오오~\n롯!데! 황!성!빈! ×2\n채태인의 롯데 자이언츠 시절 응원가를 재사용하였다. 해당 응원가는 2023 시즌에 새로운 응원가가 만들어 지며 사용하지 않게 되었다.",
    youtubeUrl: "https://www.youtube.com/results?search_query=롯데+황성빈+응원가",
  },
  "황영묵": {
    title: "황영묵 응원가",
    lyrics: "응원가 : 트랜스픽션 - 너를 원해 듣기\n한화의 황영묵 날려버려라 한화의 승리를 원하잖아 최강 한화의 승리를 위해 날려라 묵이~ (×2) 황!영!묵!\n3. 투수 응원가",
    youtubeUrl: "https://www.youtube.com/results?search_query=한화+황영묵+응원가",
  },
  "후라도": {
    title: "후라도 응원가",
    lyrics: "● Daddy Yankee - Somos de Calle\n4. 군입대 선수 응원가\n4.1. 김현준\n김현준! 워워우워어~\n김현준! 워어우워어~\n김현준! 워어우워어~\n김현준! 워워우 안타날려준!\n김현준! 워워우워어~\n김현준! 워어우워어~\n김현준! 워어우워어~\n김현준! 워워우 안타날려준!",
    youtubeUrl: "https://www.youtube.com/results?search_query=삼성+후라도+응원가",
  },
};

interface Props {
  playerName: string;
  teamColor: string;
}

export default function CheerSong({ playerName, teamColor }: Props) {
  const song = CHEER_SONGS[playerName];
  const [showLyrics, setShowLyrics] = useState(true);

  if (!song) return null;

  return (
    <GlassCard className="p-4 mb-4">
      <button
        onClick={() => setShowLyrics(!showLyrics)}
        className="w-full flex items-center justify-between"
      >
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: teamColor + "20" }}>
            <Music size={16} style={{ color: teamColor }} />
          </div>
          <div className="text-left">
            <h3 className="text-sm font-bold text-text-primary">{song.title}</h3>
            {song.note && <p className="text-xs text-text-tertiary">{song.note}</p>}
          </div>
        </div>
        {showLyrics ? <ChevronUp size={18} className="text-text-tertiary" /> : <ChevronDown size={18} className="text-text-tertiary" />}
      </button>

      {showLyrics && (
        <div className="mt-3 space-y-3">
          {/* 가사 */}
          <div className="bg-bg-tertiary rounded-xl p-4">
            <p className="text-sm text-text-primary whitespace-pre-line leading-relaxed text-center font-medium">
              {song.lyrics}
            </p>
          </div>

          {/* YouTube 링크 */}
          {song.youtubeUrl && (
            <a
              href={song.youtubeUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center justify-center gap-2 py-2.5 rounded-xl text-sm font-semibold text-white transition-all active:scale-95"
              style={{ backgroundColor: teamColor }}
            >
              <Play size={16} fill="white" />
              응원가 검색하기
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </GlassCard>
  );
}
