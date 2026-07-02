import http2 from "node:http2";
import { SignJWT, importPKCS8 } from "jose";

// APNs 직접 푸시 (Live Activity update/start/end). FCM은 Live Activity 푸시를 지원하지
// 않으므로 APNs 토큰 인증(JWT ES256)으로 직접 보낸다.
//
// 필요 env:
//  - APNS_KEY_ID  : .p8 Key ID (AuthKey_<KEYID>.p8)
//  - APNS_TEAM_ID : Apple Developer Team ID
//  - APNS_P8      : .p8 파일 내용(PEM, -----BEGIN PRIVATE KEY----- 포함)
//  - APNS_ENV     : "sandbox" | "production" (기본 sandbox — 현재 빌드 aps-environment=development)
//
// bundle id = fan.keubo.app → Live Activity topic = "fan.keubo.app.push-type.liveactivity".

const BUNDLE_ID = "fan.keubo.app";
const LIVE_ACTIVITY_TOPIC = `${BUNDLE_ID}.push-type.liveactivity`;

const PROD_HOST = "api.push.apple.com";
const SANDBOX_HOST = "api.sandbox.push.apple.com";

/** APNS_ENV가 가리키는 1차 시도 호스트(기본 sandbox). 실패 시 반대 env로 재시도한다. */
function apnsHost(): string {
  return (process.env.APNS_ENV || "sandbox") === "production" ? PROD_HOST : SANDBOX_HOST;
}

/** APNs provider JWT(ES256). 최대 1시간 유효 — 호출 단위 생성(서버리스 단순화). */
async function providerToken(): Promise<string> {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const p8 = process.env.APNS_P8;
  if (!keyId || !teamId || !p8) {
    throw new Error("APNS env missing (APNS_KEY_ID/APNS_TEAM_ID/APNS_P8)");
  }
  const key = await importPKCS8(p8.replace(/\\n/g, "\n"), "ES256");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: keyId })
    .setIssuer(teamId)
    .setIssuedAt()
    .sign(key);
}

export type LiveActivityEvent = "start" | "update" | "end";

export interface LiveActivityPushInput {
  pushToken: string;
  event: LiveActivityEvent;
  /** ContentState (KBOGameAttributes.ContentState 키와 정확히 일치해야 함). */
  contentState: Record<string, unknown>;
  /** event=end일 때 카드 잔상 종료 시각(unix sec). 미지정 시 즉시. */
  dismissalDate?: number;
  /** 콘텐츠 신선도 만료(unix sec). 이후 시스템이 "outdated" 표시. */
  staleDate?: number;
  /** event=start(W3b push-to-start) 전용 — ActivityAttributes 타입명("KBOGameAttributes"). */
  attributesType?: string;
  /** event=start 전용 — static attributes(KBOGameAttributes Codable 키와 일치). */
  attributes?: Record<string, unknown>;
  /** event=start 전용 — 잠금화면 배너 alert(선택). 미지정 시 무음 시작. */
  alert?: { title: string; body: string };
  /**
   * APNs collapse id(선택). 같은 값의 이전 푸시를 APNs가 최신 1건으로 덮어씀.
   * update/end에 경기 id를 넘겨 (1) 저장 중인 update를 최신으로만 유지 (2) end가 대기 중
   * update를 대체(종료 후 stale update 재생 방지)하게 한다.
   */
  collapseId?: string;
}

export interface ApnsResult {
  ok: boolean;
  status: number;
  /** APNs 'Unregistered'/'BadDeviceToken' 등 → 토큰 정리 필요 */
  invalidToken: boolean;
  reason?: string;
}

// update 푸시 store-and-forward 창(초). expiration:0(즉시 폐기) 대신 짧게 둬, 기기가 잠깐
// unreachable이었다가 이 창 안에 깨어나면 APNs가 보관하던 최신 update를 전달한다(collapse-id로
// 최신 1건만 유지되므로 backlog·역순 재생 없음). 카드가 갱신 갭에 옛 값으로 멈춘 채 남는 것을 줄임.
const UPDATE_STORE_FORWARD_SEC = 5 * 60;

/**
 * 단일 Live Activity 푸시 전송. APNs는 HTTP/2 필수라 node:http2로 직접 연결한다.
 * 토큰별로 연결을 새로 여는 단순 구현(배치는 호출부에서 Promise.all).
 */
export async function sendLiveActivityPush(
  input: LiveActivityPushInput,
  jwt?: string,
): Promise<ApnsResult> {
  const token = jwt ?? (await providerToken());
  // 1차 = APNS_ENV 호스트. BadDeviceToken(= 토큰이 반대 env용)이면 반대 호스트로 1회 재시도.
  // dev(sandbox) 빌드와 출시(production) 빌드 토큰을 한 서버에서 모두 처리하기 위함.
  const primary = apnsHost();
  const other = primary === PROD_HOST ? SANDBOX_HOST : PROD_HOST;
  const first = await sendToHost(input, token, primary);
  if (first.ok || first.reason !== "BadDeviceToken") return first;
  return sendToHost(input, token, other);
}

async function sendToHost(
  input: LiveActivityPushInput,
  token: string,
  host: string,
): Promise<ApnsResult> {
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: input.event,
    "content-state": input.contentState,
  };
  if (input.event === "end" && input.dismissalDate != null) {
    aps["dismissal-date"] = input.dismissalDate;
  }
  if (input.event === "start") {
    // push-to-start payload — static attributes를 동봉해 시스템이 Activity를 생성한다.
    if (input.attributesType) aps["attributes-type"] = input.attributesType;
    if (input.attributes) aps["attributes"] = input.attributes;
    if (input.alert) aps["alert"] = input.alert;
  }
  if (input.staleDate != null) aps["stale-date"] = input.staleDate;
  const body = JSON.stringify({ aps });

  return new Promise<ApnsResult>((resolve) => {
    const client = http2.connect(`https://${host}`);
    let settled = false;
    const done = (r: ApnsResult) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(r);
    };
    client.on("error", (e) =>
      done({ ok: false, status: 0, invalidToken: false, reason: e.message }),
    );
    const reqHeaders: Record<string, string> = {
      ":method": "POST",
      ":path": `/3/device/${input.pushToken}`,
      authorization: `bearer ${token}`,
      "apns-topic": LIVE_ACTIVITY_TOPIC,
      "apns-push-type": "liveactivity",
      // end도 priority 10 — priority 5는 APNs가 배터리 위해 지연시키는데, expiration 0과
      // 겹치면 "지연 → 즉시배달 실패 → 폐기"로 '경기 종료' 전환 푸시가 유실됐다(서버는 200
      // 받아 토큰을 지워버려 영영 재발송 안 됨). end는 경기당 1회뿐이라 빈도 budget 무관.
      "apns-priority": "10",
      // end = 미래(종료 카드 dismissal 시각)로 둬 APNs가 저장·재시도.
      // update = store-and-forward 창(collapse-id로 최신 1건만 보관 → 기기 깨어날 때 갱신).
      // start = 즉시성 우선 + 시점 지나면 무의미하므로 0(1회 시도) 유지.
      "apns-expiration":
        input.event === "end"
          ? String(input.dismissalDate ?? Math.floor(Date.now() / 1000) + 3600)
          : input.event === "update"
            ? String(Math.floor(Date.now() / 1000) + UPDATE_STORE_FORWARD_SEC)
            : "0",
      "content-type": "application/json",
    };
    // collapse-id: 같은 경기의 이전 update를 최신으로만 유지 + end가 대기 update를 대체.
    if (input.collapseId) reqHeaders["apns-collapse-id"] = input.collapseId;
    const req = client.request(reqHeaders);
    let status = 0;
    let data = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
    });
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (status === 200) {
        done({ ok: true, status, invalidToken: false });
        return;
      }
      let reason = data;
      try {
        reason = JSON.parse(data).reason ?? data;
      } catch {
        /* keep raw */
      }
      const invalidToken =
        status === 410 ||
        reason === "Unregistered" ||
        reason === "BadDeviceToken" ||
        reason === "DeviceTokenNotForTopic";
      done({ ok: false, status, invalidToken, reason });
    });
    req.on("error", (e) =>
      done({ ok: false, status: 0, invalidToken: false, reason: e.message }),
    );
    req.setTimeout(8000, () => {
      req.close();
      done({ ok: false, status: 0, invalidToken: false, reason: "timeout" });
    });
    req.end(body);
  });
}

/** APNs 설정이 존재하는지(미설정이면 W3 푸시 전체 no-op). */
export function apnsConfigured(): boolean {
  return Boolean(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_P8);
}

/** JWT 1회 생성해 여러 푸시에 재사용(같은 cron run 내 배치용). */
export async function getProviderTokenSafe(): Promise<string | null> {
  try {
    return await providerToken();
  } catch (e) {
    console.error("[apns] provider token failed:", (e as Error).message);
    return null;
  }
}
