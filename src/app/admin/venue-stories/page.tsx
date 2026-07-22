"use client";

import { useCallback, useEffect, useState } from "react";

interface AdminStory {
  id: number;
  gameId: string;
  mediaType: "video" | "image";
  mediaUrl: string;
  thumbUrl: string | null;
  caption: string | null;
  status: string;
  reportCount: number;
  stadiumName: string | null;
  createdAt: string;
  nickname: string;
}

function getPin(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem("admin_pin") || "";
}

export default function AdminVenueStoriesPage() {
  const [stories, setStories] = useState<AdminStory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/venue-stories", {
        headers: { "x-admin-pin": getPin() },
      });
      const data = await res.json();
      if (data.error) setError(data.error);
      else setStories(data.stories ?? []);
    } catch {
      setError("불러오기 실패");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const remove = async (id: number) => {
    if (!confirm("이 직관 스토리를 내릴까요?")) return;
    const res = await fetch("/api/admin/venue-stories", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-pin": getPin() },
      body: JSON.stringify({ storyId: id }),
    });
    const data = await res.json();
    if (data.error) alert(data.error);
    else setStories((prev) => prev.filter((s) => s.id !== id));
  };

  return (
    <div className="p-4 max-w-3xl mx-auto text-white">
      <h1 className="text-lg font-bold mb-3">직관 라이브 모더레이션</h1>
      {loading && <p className="text-sm text-gray-400">불러오는 중…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex flex-col gap-2">
        {stories.map((s) => (
          <div key={s.id} className="flex gap-3 items-center bg-white/5 rounded-lg p-2">
            <div className="w-14 h-20 rounded overflow-hidden bg-black/40 shrink-0">
              {s.thumbUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={s.thumbUrl} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-xs">
                  {s.mediaType === "video" ? "🎬" : "📷"}
                </div>
              )}
            </div>
            <div className="flex-1 min-w-0 text-xs">
              <p className="font-semibold truncate">
                {s.nickname || "익명"} · {s.stadiumName ?? s.gameId}
              </p>
              <p className="text-gray-400 truncate">{s.caption ?? "(캡션 없음)"}</p>
              <p className="text-gray-500">
                {s.mediaType} · {s.status} · 신고 {s.reportCount} ·{" "}
                {new Date(s.createdAt).toLocaleString("ko-KR")}
              </p>
            </div>
            <button
              onClick={() => remove(s.id)}
              className="px-3 py-1.5 rounded-lg bg-red-500/20 text-red-300 text-xs font-semibold shrink-0"
            >
              내림
            </button>
          </div>
        ))}
        {!loading && stories.length === 0 && (
          <p className="text-sm text-gray-500">활성 직관 스토리가 없습니다.</p>
        )}
      </div>
    </div>
  );
}
