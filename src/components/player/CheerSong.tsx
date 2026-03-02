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
  // LG 트윈스
  "오스틴": {
    title: "오스틴 응원가",
    lyrics: "오~ 오스틴~ 오오오~ 오스틴~\n우리의 오스틴~\n홈런을 쳐라~ 오스틴~\n승리를 향해~ 오스틴~",
    youtubeUrl: "https://youtube.com/shorts/O4f5R3zhBfk",
  },
  "박동원": {
    title: "박동원 응원가",
    lyrics: "박동원~ 박동원~\n우리의 박동원~\n힘차게 날려라~\n박동원~ 박동원~",
    youtubeUrl: "https://youtube.com/shorts/rlTqx8qVwrY",
  },
  "임찬규": {
    title: "임찬규 응원가",
    lyrics: "임찬규~ 임찬규~\n삼진을 잡아라~\n불꽃같은 직구로~\n임찬규~ 임찬규~",
    youtubeUrl: "https://youtube.com/shorts/84K5aU0u1WE",
  },
  "고우석": {
    title: "고우석 응원가",
    lyrics: "고우석~ 고우석~\n마지막을 지켜라~\n9회의 수호신~\n고우석~ 고우석~",
    youtubeUrl: "https://youtube.com/shorts/0vRpRzL7SYc",
  },
  "홍창기": {
    title: "홍창기 응원가",
    lyrics: "홍창기~ 홍창기~\n달려라 홍창기~\n1번의 자리를~\n홍창기가 지킨다~",
    youtubeUrl: "https://youtube.com/shorts/1xNFJcZdqwQ",
  },

  // KIA 타이거즈
  "김도영": {
    title: "김도영 응원가",
    lyrics: "김도영~ 김도영~\n광주의 별이여~\n화려한 플레이로~\n모두를 놀라게 해~\n김도영~ 김도영~",
    youtubeUrl: "https://youtube.com/shorts/dJIGpm9oJag",
  },
  "양현종": {
    title: "양현종 응원가",
    lyrics: "양현종~ 양현종~\n우리의 에이스~\n마운드의 사자여~\n양현종~ 양현종~",
    youtubeUrl: "https://youtube.com/shorts/Bv8kVmsi3Xo",
  },
  "안우진": {
    title: "안우진 응원가",
    lyrics: "안우진~ 안우진~\n불꽃의 직구로~\n삼진을 잡아라~\n안우진~ 안우진~",
    youtubeUrl: "https://youtube.com/shorts/Qq2vIEu5I9s",
  },
  "최형우": {
    title: "최형우 응원가",
    lyrics: "최형우~ 최형우~\n형이니까 믿는다~\n묵직한 한 방으로~\n최형우~ 최형우~",
    youtubeUrl: "https://youtube.com/shorts/z0VkEoVNvq4",
  },

  // 삼성 라이온즈
  "구자욱": {
    title: "구자욱 응원가",
    lyrics: "구자욱~ 구자욱~ 자~욱~\n너만 믿는다 구자욱~\n화려한 배팅으로~\n구자욱~ 구자욱~",
    youtubeUrl: "https://youtube.com/shorts/YqJONBxwPFc",
  },
  "김영웅": {
    title: "김영웅 응원가",
    lyrics: "김영웅~ 김영웅~\n우리의 영웅이여~\n힘차게 날려라~\n김영웅~ 김영웅~",
    youtubeUrl: "https://youtube.com/shorts/UwPcULr6p78",
  },

  // 두산 베어스
  "김하성": {
    title: "김하성 응원가",
    lyrics: "김하성~ 김하성~\n돌아온 김하성~\n화려한 수비와~\n강한 타격으로~\n김하성~ 김하성~",
    note: "2026 KBO 복귀 후 신규 응원가 제작 예정",
  },
  "양의지": {
    title: "양의지 응원가",
    lyrics: "양의지~ 양의지~\n우리의 양의지~\n마스크를 쓰면~\n철벽의 수비~\n양의지~ 양의지~",
    youtubeUrl: "https://youtube.com/shorts/1I_jIGWUfCE",
  },

  // 한화 이글스
  "문동주": {
    title: "문동주 응원가",
    lyrics: "문동주~ 문동주~\n불꽃의 투수~\n강속구 하나면~\n삼진이 바로~\n문동주~ 문동주~",
    youtubeUrl: "https://youtube.com/shorts/2FFHwVfB_nU",
  },
  "노시환": {
    title: "노시환 응원가",
    lyrics: "노시환~ 노시환~\n대전의 슬러거~\n담장을 넘겨라~\n노시환~ 노시환~",
    youtubeUrl: "https://youtube.com/shorts/T2qQhVxgQjA",
  },

  // SSG 랜더스
  "최정": {
    title: "최정 응원가",
    lyrics: "최정~ 최정~\n홈런왕 최정~\n빠던의 전설~\n담장 너머로~\n최정~ 최정~",
    youtubeUrl: "https://youtube.com/shorts/M5ZJJ2S7xqE",
  },
  "페르난데스": {
    title: "페르난데스 응원가",
    lyrics: "페르난데스~ 페르난데스~\n삼진을 잡아라~\n마운드의 지배자~\n페르난데스~",
  },

  // 롯데 자이언츠
  "전준우": {
    title: "전준우 응원가",
    lyrics: "전준우~ 전준우~\n사직의 전설~\n힘차게 날려라~\n전준우~ 전준우~",
    youtubeUrl: "https://youtube.com/shorts/Bnq0oHNqpJk",
  },
  "한석현": {
    title: "한석현 응원가",
    lyrics: "한석현~ 한석현~\n달려라 한석현~\n빠른 발로~\n한석현~ 한석현~",
  },

  // KT 위즈
  "강백호": {
    title: "강백호 응원가",
    lyrics: "강백호~ 강백호~\n위대한 타자~\n힘차게 날려라~\n홈런을 쳐라~\n강백호~ 강백호~",
    youtubeUrl: "https://youtube.com/shorts/4x0h1p1vpyU",
    note: "KBO에서 가장 중독성 있는 응원가로 유명",
  },

  // 키움 히어로즈
  "이정후": {
    title: "이정후 응원가",
    lyrics: "이정후~ 이정후~ 짠~\n안타를 쳐라~\n이정후~ 이정후~\n우리의 이정후~",
    youtubeUrl: "https://youtube.com/shorts/ywTHvMIOqVQ",
  },
  "이의리": {
    title: "이의리 응원가",
    lyrics: "이의리~ 이의리~\n화끈한 직구~\n삼진을 잡아라~\n이의리~ 이의리~",
  },

  // NC 다이노스
  "나성범": {
    title: "나성범 응원가",
    lyrics: "나성범~ 나성범~\n창원의 자존심~\n강한 어깨와~\n화끈한 타격~\n나성범~ 나성범~",
    youtubeUrl: "https://youtube.com/shorts/cCSYEpLZHBQ",
  },
  "소형준": {
    title: "소형준 응원가",
    lyrics: "소형준~ 소형준~\n좌완의 에이스~\n삼진을 잡아라~\n소형준~ 소형준~",
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
              응원가 영상 보기
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      )}
    </GlassCard>
  );
}
