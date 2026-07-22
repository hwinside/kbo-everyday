"use client";

export interface StorageUploadProgress {
  loaded: number;
  total: number;
  percent: number;
}

interface UploadProgressEvent {
  lengthComputable: boolean;
  loaded: number;
  total: number;
}

interface UploadRequest {
  status: number;
  upload: {
    onprogress: ((event: UploadProgressEvent) => void) | null;
  };
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  open(method: string, url: string): void;
  setRequestHeader(name: string, value: string): void;
  send(body: FormData): void;
}

export type UploadRequestFactory = () => UploadRequest;

export interface StorageUploadOptions {
  bucket: string;
  path: string;
  data: Blob;
  accessToken: string;
  supabaseUrl: string;
  anonKey: string;
  cacheControl: string;
  onProgress?: (progress: StorageUploadProgress) => void;
}

/** Supabase Storage object endpoint용으로 경로의 각 segment만 인코딩한다. */
export function buildStorageObjectUrl(
  supabaseUrl: string,
  bucket: string,
  path: string,
): string {
  const base = supabaseUrl.replace(/\/+$/, "");
  const encodedBucket = encodeURIComponent(bucket);
  const encodedPath = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `${base}/storage/v1/object/${encodedBucket}/${encodedPath}`;
}

/** Supabase SDK의 multipart upload 계약을 유지하면서 XHR의 실제 전송률을 노출한다. */
export function uploadStorageObjectWithProgress(
  options: StorageUploadOptions,
  createRequest: UploadRequestFactory = () => new XMLHttpRequest() as unknown as UploadRequest,
): Promise<boolean> {
  const {
    bucket,
    path,
    data,
    accessToken,
    supabaseUrl,
    anonKey,
    cacheControl,
    onProgress,
  } = options;

  return new Promise((resolve) => {
    const xhr = createRequest();
    const form = new FormData();
    form.append("cacheControl", cacheControl);
    form.append("", data);

    // 일부 Safari/WebView는 upload listener를 open() 뒤에 붙이면 progress를 누락한다.
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      const percent = Math.min(100, Math.max(0, Math.round((event.loaded / event.total) * 100)));
      onProgress?.({ loaded: event.loaded, total: event.total, percent });
    };
    xhr.onload = () => {
      const ok = xhr.status >= 200 && xhr.status < 300;
      if (ok) onProgress?.({ loaded: data.size, total: data.size, percent: 100 });
      resolve(ok);
    };
    xhr.onerror = () => resolve(false);
    xhr.onabort = () => resolve(false);

    xhr.open("POST", buildStorageObjectUrl(supabaseUrl, bucket, path));
    xhr.setRequestHeader("Authorization", `Bearer ${accessToken}`);
    xhr.setRequestHeader("apikey", anonKey);
    xhr.setRequestHeader("x-upsert", "false");
    xhr.send(form);
  });
}
