import { getKSTNow, getKSTToday } from "@/lib/utils/date-kst";

/**
 * 구장별 날씨 (경기 시간 기준 예보 + 실시간).
 *
 * 데이터 소스: Open-Meteo (https://open-meteo.com) — API 키 불필요, 시간별
 * 강수확률/기온/날씨코드 제공. 외부 API 호출은 이 파일의 fetchStadiumWeather
 * 하나로만 나간다 (엔드포인트/파라미터 변경 시 여기 한 곳만 수정).
 */

interface StadiumCoord {
  lat: number;
  lon: number;
  /** 돔구장 — 우천취소 무관이므로 강수확률 노출 생략 */
  indoor?: boolean;
}

/** KBO ScoreBoard S_NM(구장 짧은 이름) → 좌표. 미등록 구장은 날씨 미노출(graceful). */
const STADIUM_COORDS: Record<string, StadiumCoord> = {
  잠실: { lat: 37.5122, lon: 127.0719 },
  고척: { lat: 37.4982, lon: 126.8672, indoor: true },
  문학: { lat: 37.437, lon: 126.6932 },
  수원: { lat: 37.2997, lon: 127.0097 },
  대전: { lat: 36.317, lon: 127.429 },
  대구: { lat: 35.8411, lon: 128.6815 },
  사직: { lat: 35.194, lon: 129.0615 },
  창원: { lat: 35.2225, lon: 128.5825 },
  광주: { lat: 35.1682, lon: 126.8884 },
  울산: { lat: 35.5322, lon: 129.2655 },
  포항: { lat: 36.0081, lon: 129.3593 },
  청주: { lat: 36.6386, lon: 127.4702 },
};

export interface StadiumHourWeather {
  /** 0~23 (KST) */
  hour: number;
  /** 강수확률 % (null = 데이터 없음) */
  pop: number | null;
  /** 기온 °C */
  temp: number | null;
  /** WMO weather code */
  code: number | null;
}

export interface StadiumWeather {
  indoor: boolean;
  hourly: StadiumHourWeather[];
}

export type StadiumWeatherMap = Record<string, StadiumWeather>;

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";
const HOURLY_VARS = "precipitation_probability,temperature_2m,weather_code";

/**
 * 요청 구장들의 해당 날짜 시간별 날씨를 한 번의 멀티 로케이션 호출로 가져온다.
 * @param date YYYYMMDD
 */
export async function fetchStadiumWeather(
  date: string,
  stadiums: string[],
): Promise<StadiumWeatherMap> {
  const known = [...new Set(stadiums)].filter((s) => STADIUM_COORDS[s]);
  if (known.length === 0) return {};

  const isoDate = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  const params = new URLSearchParams({
    latitude: known.map((s) => STADIUM_COORDS[s].lat).join(","),
    longitude: known.map((s) => STADIUM_COORDS[s].lon).join(","),
    hourly: HOURLY_VARS,
    timezone: "Asia/Seoul",
    start_date: isoDate,
    end_date: isoDate,
  });

  const res = await fetch(`${OPEN_METEO_BASE}?${params}`, {
    next: { revalidate: 600 },
  });
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);

  const json = await res.json();
  // 단일 로케이션이면 객체, 복수면 배열로 온다.
  const results: OpenMeteoResult[] = Array.isArray(json) ? json : [json];

  const map: StadiumWeatherMap = {};
  known.forEach((name, i) => {
    const r = results[i];
    if (!r?.hourly?.time) return;
    map[name] = {
      indoor: STADIUM_COORDS[name].indoor === true,
      hourly: r.hourly.time.map((t, h) => ({
        hour: parseHour(t, h),
        pop: r.hourly!.precipitation_probability?.[h] ?? null,
        temp: r.hourly!.temperature_2m?.[h] ?? null,
        code: r.hourly!.weather_code?.[h] ?? null,
      })),
    };
  });
  return map;
}

interface OpenMeteoResult {
  hourly?: {
    time: string[];
    precipitation_probability?: (number | null)[];
    temperature_2m?: (number | null)[];
    weather_code?: (number | null)[];
  };
}

/** "2026-07-08T18:00" → 18. 파싱 실패 시 배열 인덱스(0~23)로 폴백. */
function parseHour(isoLocal: string, fallback: number): number {
  const m = /T(\d{2}):/.exec(isoLocal);
  return m ? parseInt(m[1], 10) : fallback;
}

/** WMO weather code → 이모지 */
export function weatherEmoji(code: number | null): string {
  if (code === null) return "🌡️";
  if (code === 0) return "☀️";
  if (code <= 2) return "🌤️";
  if (code === 3) return "☁️";
  if (code === 45 || code === 48) return "🌫️";
  if (code >= 51 && code <= 57) return "🌦️";
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return "🌧️";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "🌨️";
  if (code >= 95) return "⛈️";
  return "🌡️";
}

/** 경기 카드에 표시할 최종 날씨 정보 */
export interface GameWeather {
  emoji: string;
  temp: number | null;
  /** 강수확률 % — 돔구장이면 null */
  pop: number | null;
  indoor: boolean;
}

/**
 * 경기 하나에 표시할 날씨를 고른다.
 * - live: 현재 시각(KST) 기준 실시간
 * - scheduled: 경기 시작 시각 기준 예보
 * @param time "18:30" 형태 (KBO API)
 */
export function pickGameWeather(
  weather: StadiumWeather | undefined,
  game: { status: string; time: string },
  date: string /* YYYY-MM-DD */,
): GameWeather | null {
  if (!weather || weather.hourly.length === 0) return null;

  let hour: number;
  if (game.status === "live" && date === getKSTToday()) {
    hour = getKSTNow().getHours();
  } else {
    const m = /^(\d{1,2}):/.exec(game.time);
    if (!m) return null;
    hour = parseInt(m[1], 10);
  }

  const slot =
    weather.hourly.find((h) => h.hour === hour) ??
    weather.hourly[Math.min(hour, weather.hourly.length - 1)];
  if (!slot || (slot.temp === null && slot.pop === null)) return null;

  return {
    emoji: weatherEmoji(slot.code),
    temp: slot.temp === null ? null : Math.round(slot.temp),
    pop: weather.indoor ? null : slot.pop,
    indoor: weather.indoor,
  };
}
