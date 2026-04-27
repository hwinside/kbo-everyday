"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Pencil, Trash2, Eye, EyeOff, Loader2 } from "lucide-react";

interface Announcement {
  id: string;
  title: string;
  summary: string;
  body: string;
  cta_label: string | null;
  cta_path: string | null;
  published_at: string;
  display_until: string | null;
  is_active: boolean;
  created_at: string;
}

function getPin(): string {
  return typeof window !== "undefined" ? sessionStorage.getItem("admin_pin") || "" : "";
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ko-KR", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

const EMPTY_FORM = {
  title: "",
  summary: "",
  body: "",
  cta_label: "",
  cta_path: "",
  display_until: "",
};

export default function AdminWhatsNewPage() {
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchItems = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/admin/whats-new", {
        headers: { "x-admin-pin": getPin() },
      });
      if (res.ok) setItems(await res.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  const openCreate = () => {
    setEditId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError("");
  };

  const openEdit = (item: Announcement) => {
    setEditId(item.id);
    setForm({
      title: item.title,
      summary: item.summary,
      body: item.body,
      cta_label: item.cta_label || "",
      cta_path: item.cta_path || "",
      display_until: item.display_until?.slice(0, 16) || "",
    });
    setShowForm(true);
    setError("");
  };

  const handleSave = async () => {
    if (!form.title || !form.summary || !form.body) {
      setError("제목, 요약, 본문은 필수입니다");
      return;
    }
    if (form.cta_path && !/^\/[A-Za-z0-9/_?=&%#.-]*$/.test(form.cta_path)) {
      setError("CTA 경로는 /로 시작하는 내부 경로만 가능합니다");
      return;
    }

    setSaving(true);
    setError("");

    const payload: Record<string, unknown> = {
      title: form.title,
      summary: form.summary,
      body: form.body,
      cta_label: form.cta_label || null,
      cta_path: form.cta_path || null,
      display_until: form.display_until ? new Date(form.display_until).toISOString() : null,
    };
    if (editId) payload.id = editId;

    try {
      const res = await fetch("/api/admin/whats-new", {
        method: editId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", "x-admin-pin": getPin() },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const err = await res.json();
        setError(err.error || "저장 실패");
      } else {
        setShowForm(false);
        fetchItems();
      }
    } catch {
      setError("네트워크 오류");
    }
    setSaving(false);
  };

  const handleToggle = async (item: Announcement) => {
    await fetch("/api/admin/whats-new", {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-admin-pin": getPin() },
      body: JSON.stringify({ id: item.id, is_active: !item.is_active }),
    });
    fetchItems();
  };

  const handleDelete = async (id: string) => {
    if (!confirm("정말 삭제할까요?")) return;
    await fetch("/api/admin/whats-new", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "x-admin-pin": getPin() },
      body: JSON.stringify({ id }),
    });
    fetchItems();
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">새 소식 관리</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 transition-colors"
        >
          <Plus size={16} /> 새 공지
        </button>
      </div>

      {/* Form Modal */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-lg rounded-2xl bg-[var(--bg-secondary)] p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <h2 className="text-lg font-bold">{editId ? "공지 수정" : "새 공지 작성"}</h2>

            <div>
              <label className="block text-xs text-text-secondary mb-1">제목 *</label>
              <input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
                placeholder="이번 주 업데이트 소식"
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">한줄 요약 * (홈 카드 표시)</label>
              <input
                value={form.summary}
                onChange={(e) => setForm({ ...form, summary: e.target.value })}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
                placeholder="GIPHY 댓글, 커스텀 아바타 등 6가지 새 기능!"
              />
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">본문 * (줄바꿈으로 구분)</label>
              <textarea
                value={form.body}
                onChange={(e) => setForm({ ...form, body: e.target.value })}
                rows={8}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none resize-y"
                placeholder={"1. GIPHY 댓글 달기\n댓글에 움짤을 붙여보세요!\n\n2. 커스텀 아바타\n프로필 사진을 직접 등록하세요."}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1">CTA 버튼 텍스트</label>
                <input
                  value={form.cta_label}
                  onChange={(e) => setForm({ ...form, cta_label: e.target.value })}
                  className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
                  placeholder="새 기능 둘러보기"
                />
              </div>
              <div>
                <label className="block text-xs text-text-secondary mb-1">CTA 경로 (/로 시작)</label>
                <input
                  value={form.cta_path}
                  onChange={(e) => setForm({ ...form, cta_path: e.target.value })}
                  className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
                  placeholder="/community"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs text-text-secondary mb-1">표시 종료일 (비우면 무기한)</label>
              <input
                type="datetime-local"
                value={form.display_until}
                onChange={(e) => setForm({ ...form, display_until: e.target.value })}
                className="w-full rounded-lg bg-[var(--bg-tertiary)] px-3 py-2 text-sm text-text-primary outline-none"
              />
            </div>

            {error && <p className="text-sm text-red-400">{error}</p>}

            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setShowForm(false)}
                className="rounded-lg px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                취소
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
              >
                {saving && <Loader2 size={14} className="animate-spin" />}
                {editId ? "수정" : "등록"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="animate-spin text-text-tertiary" size={24} />
        </div>
      ) : items.length === 0 ? (
        <div className="py-12 text-center text-text-tertiary text-sm">
          등록된 공지가 없습니다
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              className={`rounded-xl bg-[var(--bg-secondary)] p-4 border border-[var(--color-border)] ${!item.is_active ? "opacity-50" : ""}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-medium ${item.is_active ? "bg-green-500/20 text-green-400" : "bg-gray-500/20 text-gray-400"}`}>
                      {item.is_active ? "활성" : "비활성"}
                    </span>
                    <span className="text-xs text-text-tertiary">{formatDate(item.published_at)}</span>
                    {item.display_until && (
                      <span className="text-xs text-text-tertiary">~ {formatDate(item.display_until)}</span>
                    )}
                  </div>
                  <h3 className="text-sm font-semibold text-text-primary">{item.title}</h3>
                  <p className="mt-0.5 text-xs text-text-secondary truncate">{item.summary}</p>
                  {item.cta_label && (
                    <p className="mt-1 text-xs text-blue-400">
                      CTA: {item.cta_label} → {item.cta_path}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    onClick={() => handleToggle(item)}
                    className="rounded-lg p-2 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
                    title={item.is_active ? "비활성화" : "활성화"}
                  >
                    {item.is_active ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                  <button
                    onClick={() => openEdit(item)}
                    className="rounded-lg p-2 text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-colors"
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="rounded-lg p-2 text-text-tertiary hover:text-red-400 hover:bg-white/5 transition-colors"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
