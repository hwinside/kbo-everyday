/**
 * 배치/크롤러 헬스 판정 (server+client 공용, 순수 함수).
 *
 * 배경(2026-07-14): 배치탭이 job별 *최신 로그 status만* 보여주고 신선도를 안 봐서,
 * roster-update가 85일 전 success 로그로 계속 green + stats-update는 "성공"인데 실제
 * 데이터는 동결(정적 스탯 생성일이 오래됨)인 걸 못 잡음. 아래 규칙으로:
 *   - error: 최근 실행이 실패
 *   - stale(data): 크롤 job인데 데이터 반영 시각이 오래됨 ("성공인데 반영 안 됨" 포착)
 *   - stale(run): admin_job_logs 로 추적되는 잡이 예상 주기 내 실행이 없음 (멈춘 크론)
 *   - partial: 최근 실행이 부분실패(warning) — 실행은 정상, 일부 오류
 *   - unknown: admin 로그 미기록 + 데이터 신호도 없음 → 판정 불가(회색, 문제 아님)
 *   - healthy: 정상
 *
 * false positive 방지 원칙: "로그가 없다"만으로 빨간 문제로 띄우지 않는다. GH Actions 등
 * admin_job_logs 를 안 남기는 잡(tracked=false)은 데이터 신선도 신호가 있을 때만 판정한다.
 */

export type JobHealthLevel = "healthy" | "partial" | "stale" | "error" | "unknown";

export interface JobDef {
  name: string;
  label: string;
  schedule: string;
  description: string;
  /** 이 시간(h)을 넘도록 실행이 없으면 stale (tracked 잡에만 적용) */
  maxAgeHours: number;
  /** admin_job_logs 에 실행 로그를 남기는 잡인지 (false = GH Actions 등 외부 실행) */
  tracked: boolean;
  /** 크롤 산출물(정적 스탯) 신선도까지 보는 잡 */
  dataFreshness?: boolean;
}

/** 크롤 산출 데이터(정적 스탯 등)가 이 시간(h)보다 오래되면 stale — 일 단위 크롤이라 2일 */
export const DATA_MAX_AGE_HOURS = 48;

export const JOB_DEFS: JobDef[] = [
  { name: "youtube-highlights", label: "유튜브 하이라이트", schedule: "매 4시간", description: "구단별 유튜브 하이라이트 영상 수집", maxAgeHours: 10, tracked: true },
  { name: "videos-rss", label: "영상 수집 (RSS)", schedule: "매 2시간", description: "channel_pool 전체 RSS 수집 (공식+커뮤니티 채널, 선수 태깅)", maxAgeHours: 6, tracked: true },
  { name: "videos-player-shorts", label: "선수 숏츠", schedule: "매일 21:30·03:30", description: "선수별 YouTube 숏츠 검색 수집", maxAgeHours: 20, tracked: true },
  { name: "stats-update", label: "선수 스탯 업데이트", schedule: "매일 06:00", description: "KBO 타자/투수 스탯 크롤링 → Supabase 저장", maxAgeHours: 30, tracked: true, dataFreshness: true },
  { name: "game-logs-ingest", label: "경기별 로그 적재", schedule: "매일 23:00/00:00/01:00", description: "종료 경기 박스스코어 → player_game_logs 멱등 적재 (경기별 탭/추이)", maxAgeHours: 30, tracked: true },
  { name: "daily-analysis", label: "일일 경기 분석", schedule: "매일 01:00", description: "Gemini 기반 순위/타이틀 변동 분석 리포트", maxAgeHours: 30, tracked: true },
  { name: "retention", label: "리텐션 집계", schedule: "매일 09:30", description: "코호트/활성화/경기일 리텐션 메트릭 집계", maxAgeHours: 30, tracked: true },
  { name: "admin-telemetry-retention", label: "트래픽 원장 보존", schedule: "매일 07:30", description: "physical backup·rollup 정합 확인 후 raw 30일/집계 1년 보존", maxAgeHours: 30, tracked: true },
  { name: "daily-fallback-report", label: "API 장애 리포트", schedule: "매일 09:00", description: "전일 API 장애 집계 → 텔레그램 전송", maxAgeHours: 30, tracked: false },
  { name: "photos-check", label: "선수 사진 모니터링", schedule: "매주 일 06:00", description: "KBO CDN 선수 사진 존재 여부 확인", maxAgeHours: 192, tracked: true },
  { name: "roster-update", label: "로스터 업데이트", schedule: "매일 05:00", description: "GitHub Actions 크롤링 → 자동 PR+머지 (스탯/로스터 반영)", maxAgeHours: 30, tracked: false, dataFreshness: true },
  { name: "hero-shot-batch", label: "히어로샷 자동 배치", schedule: "매일 03:00", description: "히어로샷 없는 선수(공식샷 보유) 탐지 → KBO 공식샷 rembg 컷아웃 생성 → 자동 PR+머지 (외부 API 없음)", maxAgeHours: 192, tracked: false },
  { name: "channel-discovery", label: "채널 자동 발굴", schedule: "매주 일 09:00", description: "active 채널 숏츠 제목 분석 → 유사 신규 채널 발굴 (shadow 2회 후 자동 활성)", maxAgeHours: 192, tracked: true },
];

export interface JobHealthInput {
  latestStatus?: string | null;
  latestAt?: string | null;
  /** dataFreshness 잡의 데이터 산출 시각 (정적 스탯 generatedAt 등) */
  dataGeneratedAt?: string | null;
}

export interface JobHealth {
  level: JobHealthLevel;
  reason: string;
  /** 마지막 실행으로부터 경과 시간(h), 실행 기록 없으면 null */
  runAgeHours: number | null;
  /** 데이터 반영 경과 시간(h), 해당 없으면 null */
  dataAgeHours: number | null;
}

function ageHours(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  return (now - t) / 3_600_000;
}

export function fmtAge(hours: number | null): string {
  if (hours == null) return "기록 없음";
  if (hours < 1) return "방금";
  if (hours < 24) return `${Math.floor(hours)}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

/** 배지에 빨간 알림으로 셀 문제 상태 (조용히 망가지는 부류). partial/unknown 은 제외. */
export function isProblem(level: JobHealthLevel): boolean {
  return level === "error" || level === "stale";
}

/** admin-alerts cron 전이 판정용 스냅샷 (2026-07-18) */
export interface JobLevelSnapshot {
  jobName: string;
  label: string;
  level: JobHealthLevel;
  reason: string;
}

export interface AdminAlertDecision {
  jobName: string;
  label: string;
  reason: string;
  kind: "problem" | "recovered";
  /** CAS claim용 — 이 전이의 기대 직전 레벨 (null = 직전 행 없음) */
  prevLevel: string | null;
  /** CAS claim용 — 이 전이가 쓰려는 새 레벨 */
  newLevel: JobHealthLevel;
}

/**
 * 어드민 알림 전이 판정 (순수 함수, admin-alerts cron 전용).
 *
 * 직전 상태(prev: job_name→level) 대비 "전이 시에만" 알림을 만든다:
 * - problem(error/stale) 진입: 직전 레벨과 다를 때만 (error↔stale 변화도 재알림 — 상황이 바뀐 것)
 * - 복구: 직전이 problem이었고 지금 healthy/partial일 때 1회
 * - unknown은 판정 불가(회색)라 경고도 복구도 만들지 않음
 * - 같은 레벨 유지 = 무알림 (30분 주기 반복 알림 방지)
 */
export function decideAdminAlerts(
  prev: Map<string, string>,
  current: JobLevelSnapshot[],
): AdminAlertDecision[] {
  const out: AdminAlertDecision[] = [];
  for (const job of current) {
    const prevLevel = prev.get(job.jobName) ?? null;
    const wasProblem = prevLevel === "error" || prevLevel === "stale";
    if (isProblem(job.level)) {
      if (job.level !== prevLevel) {
        out.push({
          jobName: job.jobName,
          label: job.label,
          reason: job.reason,
          kind: "problem",
          prevLevel,
          newLevel: job.level,
        });
      }
    } else if (wasProblem && job.level !== "unknown") {
      out.push({
        jobName: job.jobName,
        label: job.label,
        reason: job.reason,
        kind: "recovered",
        prevLevel,
        newLevel: job.level,
      });
    }
  }
  return out;
}

/**
 * 알림 전달 결과 → 상태 영속화 판정 (순수 함수, PR #681 삼순 P1 반영).
 * - "persist": 전달 성공(sent>0) 또는 구독 0개(failed=0, 전달할 대상 없음 — vacuous 성공)
 * - "revert": 전송 시도가 전부 실패(sent=0 && failed>0) → claim을 되돌려 다음 틱 재시도
 */
export function decideAlertPersistence(outcome: {
  sent: number;
  failed: number;
  queryError?: boolean;
}): "persist" | "revert" {
  // 구독 조회 DB 오류 = 전달 결과 미지 → revert (삼순 2차 P1: {0,0} 둘갑 차단)
  if (outcome.queryError) return "revert";
  if (outcome.sent === 0 && outcome.failed > 0) return "revert";
  return "persist";
}

export function computeJobHealth(def: JobDef, input: JobHealthInput, now: number): JobHealth {
  const runAgeHours = ageHours(input.latestAt, now);
  const dataAgeHours = def.dataFreshness ? ageHours(input.dataGeneratedAt, now) : null;

  // tracked=false 잡(GH Actions 등)은 admin_job_logs 를 실행 기록으로 쓸 수 없어
  // 간헐 남은 구형 로그가 오래됐는데(예: 44일 전 warning) status 만 읽으면 오탐이다.
  // 주기(maxAgeHours)를 넘은 non-tracked 로그는 판정에 쓰지 않는다.
  const logFresh = runAgeHours != null && runAgeHours <= def.maxAgeHours;
  const logUsable = def.tracked || logFresh;

  // 1) 최근 실행이 에러
  if (input.latestStatus === "error" && logUsable) {
    return { level: "error", reason: "최근 실행 실패", runAgeHours, dataAgeHours };
  }

  // 2) 데이터 동결 — 크롤 잡은 산출물 신선도가 최우선 신호 (job 은 돌아도 반영 안 됨)
  if (def.dataFreshness) {
    if (dataAgeHours == null) {
      return { level: "stale", reason: "데이터 반영 시각 확인 불가", runAgeHours, dataAgeHours };
    }
    if (dataAgeHours > DATA_MAX_AGE_HOURS) {
      return { level: "stale", reason: `데이터 반영 ${fmtAge(dataAgeHours)} 정체`, runAgeHours, dataAgeHours };
    }
  }

  // 3) 멈춘 크론 — admin_job_logs 로 추적되는 잡만 실행 신선도로 판정
  if (def.tracked) {
    if (runAgeHours == null) {
      return { level: "stale", reason: "실행 기록 없음", runAgeHours, dataAgeHours };
    }
    if (runAgeHours > def.maxAgeHours) {
      return { level: "stale", reason: `마지막 실행 ${fmtAge(runAgeHours)} (주기 초과)`, runAgeHours, dataAgeHours };
    }
  }

  // 4) 부분실패 (실행은 정상이나 일부 오류)
  if (input.latestStatus === "warning" && logUsable) {
    return { level: "partial", reason: "최근 실행 부분실패", runAgeHours, dataAgeHours };
  }

  // 5) 추적 안 되고(외부 실행) 데이터 신호도 없어 판정 불가 → 회색(문제 아님)
  // 구형 로그만 있고 주기를 넘은 non-tracked 잡도 판정 불가로 둔다(오탐 warning 방지).
  if (!def.tracked && !def.dataFreshness && !logFresh) {
    return { level: "unknown", reason: "admin 로그 미기록 (모니터링 제외)", runAgeHours, dataAgeHours };
  }

  return { level: "healthy", reason: "정상", runAgeHours, dataAgeHours };
}
