import {
  buildStorageObjectUrl,
  uploadStorageObjectWithProgress,
  type UploadRequestFactory,
} from "../../src/lib/venue-stories/upload-progress";

let passed = 0;
function ok(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  passed += 1;
  console.log(`PASS: ${name}`);
}

ok(
  "Storage URL은 bucket과 object path segment를 안전하게 인코딩한다",
  buildStorageObjectUrl(
    "https://example.supabase.co/",
    "venue-staging",
    "venue-stories/GAME 1/user/a+b.mp4",
  ) ===
    "https://example.supabase.co/storage/v1/object/venue-staging/venue-stories/GAME%201/user/a%2Bb.mp4",
);

class MockRequest {
  status = 201;
  upload = { onprogress: null as ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  method = "";
  url = "";
  headers = new Map<string, string>();
  body: FormData | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string): void {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: FormData): void {
    this.body = body;
    this.upload.onprogress?.({ lengthComputable: true, loaded: 25, total: 100 });
    this.upload.onprogress?.({ lengthComputable: true, loaded: 100, total: 100 });
    this.onload?.();
  }
}

async function main(): Promise<void> {
  const successRequest = new MockRequest();
  const progress: number[] = [];
  const uploaded = await uploadStorageObjectWithProgress(
    {
      bucket: "photos",
      path: "venue-stories/GAME/user/photo.jpg",
      data: new Blob(["photo"], { type: "image/jpeg" }),
      accessToken: "user-token",
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-key",
      cacheControl: "31536000",
      onProgress: (event) => progress.push(event.percent),
    },
    (() => successRequest) as UploadRequestFactory,
  );

  ok("2xx 응답은 업로드 성공으로 판정한다", uploaded);
  ok(
    "실제 전송 바이트를 25%와 100%로 전달한다",
    progress.includes(25) && progress.at(-1) === 100,
  );
  ok(
    "Supabase Storage multipart POST endpoint를 사용한다",
    successRequest.method === "POST" &&
      successRequest.url.endsWith(
        "/storage/v1/object/photos/venue-stories/GAME/user/photo.jpg",
      ),
  );
  ok(
    "사용자 JWT·anon key·upsert=false 헤더를 전달한다",
    successRequest.headers.get("authorization") === "Bearer user-token" &&
      successRequest.headers.get("apikey") === "anon-key" &&
      successRequest.headers.get("x-upsert") === "false",
  );
  ok(
    "SDK와 같은 cacheControl·빈 이름 파일 multipart 필드를 사용한다",
    successRequest.body?.get("cacheControl") === "31536000" &&
      successRequest.body?.get("") instanceof Blob,
  );

  const failedRequest = new MockRequest();
  failedRequest.status = 403;
  const failed = await uploadStorageObjectWithProgress(
    {
      bucket: "photos",
      path: "venue-stories/GAME/user/photo.jpg",
      data: new Blob(["photo"]),
      accessToken: "user-token",
      supabaseUrl: "https://example.supabase.co",
      anonKey: "anon-key",
      cacheControl: "31536000",
    },
    (() => failedRequest) as UploadRequestFactory,
  );
  ok("비-2xx 응답은 fail-closed 처리한다", !failed);

  console.log(`venue upload progress smoke: ${passed}/${passed} PASS`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
