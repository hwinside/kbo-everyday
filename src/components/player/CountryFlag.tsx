import { flagSrc, type Nationality } from "@/lib/utils/player-nationality";

interface Props {
  nationality: Nationality;
  /** 국기 픽셀 폭 (높이는 3:4 비율 자동) */
  size?: number;
  /** wrapper 추가 클래스 (글자 크기/색은 부모에서 상속) */
  className?: string;
}

/**
 * 외국인 선수 국적 표시: [국기 SVG] 국가명.
 * 이모지 국기(🇺🇸)는 안드로이드·삼성에서 글자로 깨지는 기기가 있어 SVG 아이콘으로 렌더.
 */
export default function CountryFlag({ nationality, size = 16, className = "" }: Props) {
  const h = Math.round((size * 3) / 4);
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- 정적 SVG 국기, next/image 최적화 불필요 */}
      <img
        src={flagSrc(nationality.code)}
        alt=""
        aria-hidden
        width={size}
        height={h}
        style={{ width: size, height: h }}
        className="shrink-0 rounded-[2px] object-cover ring-1 ring-black/15"
        loading="lazy"
        draggable={false}
      />
      <span className="whitespace-nowrap">{nationality.nameKo}</span>
    </span>
  );
}
