import http2 from "node:http2";
import { getProviderTokenSafe } from "@/lib/notifications/apns";

// APNs Broadcast 채널 (iOS 18+ Live Activity) — 스펙 v4.
// 채널 관리(생성/삭제)와 채널 broadcast 발송. 경기당 채널 1개(env별)로 전 구독 기기의
// 잠금 카드를 1건 발송으로 갱신한다 → per-디바이스 업데이트 예산 개념이 사라진다.
//
// Apple 실사양(2026-07 문서):
//  - 채널 관리: api-manage-broadcast.push.apple.com — sandbox :2195 / production :2196
//    POST /1/apps/{bundle}/channels  body {"message-storage-policy": 0, "push-type": "LiveActivity"}
//    → 201 + 응답 헤더 apns-channel-id. DELETE는 같은 경로 + apns-channel-id 헤더.
//  - 발송: api-broadcast[.sandbox].push.apple.com  POST /4/broadcasts/apps/{bundle}
//    헤더 apns-channel-id / apns-push-type liveactivity / apns-priority / apns-expiration.
//  - No-Message-Stored(=0) 정책은 고빈도(스포츠) 발행 예산이 높지만 apns-expiration: 0 필수.

const BUNDLE_ID = "fan.keubo.app";

export type ApnsEnvironment = "production" | "sandbox";

function manageOrigin(env: ApnsEnvironment): string {
  return env === "production"
    ? "https://api-manage-broadcast.push.apple.com:2196"
    : "https://api-manage-broadcast.sandbox.push.apple.com:2195";
}

function broadcastOrigin(env: ApnsEnvironment): string {
  return env === "production"
    ? "https://api-broadcast.push.apple.com"
    : "https://api-broadcast.sandbox.push.apple.com";
}

interface Http2Result {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  error?: string;
}

/** 단발 HTTP/2 요청 (APNs는 HTTP/2 필수 — node fetch 불가). */
function http2Request(params: {
  origin: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}): Promise<Http2Result> {
  return new Promise((resolve) => {
    const client = http2.connect(params.origin);
    let settled = false;
    const done = (r: Http2Result) => {
      if (settled) return;
      settled = true;
      client.close();
      resolve(r);
    };
    client.on("error", (e) => done({ status: 0, headers: {}, body: "", error: e.message }));
    const req = client.request({
      ":method": params.method,
      ":path": params.path,
      ...params.headers,
    });
    let status = 0;
    let resHeaders: Record<string, string | string[] | undefined> = {};
    let data = "";
    req.on("response", (headers) => {
      status = Number(headers[":status"]) || 0;
      resHeaders = headers as Record<string, string | string[] | undefined>;
    });
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => done({ status, headers: resHeaders, body: data }));
    req.on("error", (e) => done({ status: 0, headers: {}, body: "", error: e.message }));
    req.setTimeout(8000, () => {
      req.close();
      done({ status: 0, headers: {}, body: "", error: "timeout" });
    });
    if (params.body != null) req.end(params.body);
    else req.end();
  });
}

/** 채널 생성 → channel_id 반환. 실패 시 null (호출부가 다음 틱 재시도 — 멱등). */
export async function createBroadcastChannel(
  env: ApnsEnvironment,
  jwt?: string,
): Promise<string | null> {
  const token = jwt ?? (await getProviderTokenSafe());
  if (!token) return null;
  const res = await http2Request({
    origin: manageOrigin(env),
    path: `/1/apps/${BUNDLE_ID}/channels`,
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "content-type": "application/json",
    },
    // 0 = No Message Stored: 고빈도(스포츠 스코어) 발행 예산 상향. 발송은 expiration 0 필수.
    body: JSON.stringify({ "message-storage-policy": 0, "push-type": "LiveActivity" }),
  });
  if (res.status !== 201) {
    console.error(`[apns-broadcast] channel create failed (${env}):`, res.status, res.body || res.error);
    return null;
  }
  const id = res.headers["apns-channel-id"];
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** 채널 삭제. 404(이미 없음)도 성공으로 간주(멱등). */
export async function deleteBroadcastChannel(
  env: ApnsEnvironment,
  channelId: string,
  jwt?: string,
): Promise<boolean> {
  const token = jwt ?? (await getProviderTokenSafe());
  if (!token) return false;
  const res = await http2Request({
    origin: manageOrigin(env),
    path: `/1/apps/${BUNDLE_ID}/channels`,
    method: "DELETE",
    headers: {
      authorization: `bearer ${token}`,
      "apns-channel-id": channelId,
    },
  });
  if (res.status === 204 || res.status === 200 || res.status === 404) return true;
  console.error(`[apns-broadcast] channel delete failed (${env}):`, res.status, res.body || res.error);
  return false;
}

/**
 * 채널 broadcast 발송 (update/end). payload = per-토큰 update와 동일 aps 구조.
 * No-Message-Stored 채널이므로 apns-expiration은 항상 0.
 */
export async function sendBroadcastPush(params: {
  env: ApnsEnvironment;
  channelId: string;
  event: "update" | "end";
  contentState: Record<string, unknown>;
  priority: "10" | "5";
  dismissalDate?: number;
  jwt?: string;
}): Promise<{ ok: boolean; status: number; reason?: string }> {
  const token = params.jwt ?? (await getProviderTokenSafe());
  if (!token) return { ok: false, status: 0, reason: "no provider token" };
  const aps: Record<string, unknown> = {
    timestamp: Math.floor(Date.now() / 1000),
    event: params.event,
    "content-state": params.contentState,
  };
  if (params.event === "end" && params.dismissalDate != null) {
    aps["dismissal-date"] = params.dismissalDate;
  }
  const res = await http2Request({
    origin: broadcastOrigin(params.env),
    path: `/4/broadcasts/apps/${BUNDLE_ID}`,
    method: "POST",
    headers: {
      authorization: `bearer ${token}`,
      "apns-channel-id": params.channelId,
      "apns-push-type": "liveactivity",
      "apns-priority": params.priority,
      "apns-expiration": "0",
      "content-type": "application/json",
    },
    body: JSON.stringify({ aps }),
  });
  if (res.status === 200 || res.status === 202) return { ok: true, status: res.status };
  let reason = res.body || res.error || "";
  try {
    reason = JSON.parse(res.body).reason ?? reason;
  } catch {
    /* keep raw */
  }
  return { ok: false, status: res.status, reason };
}
