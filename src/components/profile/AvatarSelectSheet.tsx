"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X, Check, Camera, Loader2 } from "lucide-react";
import Cropper, { type Area } from "react-easy-crop";
import { PRESET_AVATARS, getPresetKey, isCustomAvatar } from "@/lib/constants/avatars";
import { supabase } from "@/lib/supabase/client";
import { useAuth } from "@/lib/supabase/AuthContext";
import { TEAMS } from "@/lib/constants/teams";

const AVATAR_SIZE = 400; // 크롭 결과 px
const AVATAR_QUALITY = 0.85;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentAvatarUrl: string | null;
  teamId: number | null;
  nickname: string;
}

/** preset key, "custom" (기존 커스텀 유지), 또는 null (이니셜) */
type Selection = string | null;

function useBodyScrollLock(isOpen: boolean) {
  useEffect(() => {
    if (!isOpen) return;

    const scrollY = window.scrollY;
    const { style } = document.body;
    style.position = "fixed";
    style.top = `-${scrollY}px`;
    style.width = "100%";
    style.overflow = "hidden";

    return () => {
      style.position = "";
      style.top = "";
      style.width = "";
      style.overflow = "";
      window.scrollTo(0, scrollY);
    };
  }, [isOpen]);
}

/** canvas에서 크롭 영역을 잘라 Blob 반환 */
async function getCroppedBlob(imageSrc: string, crop: Area): Promise<Blob> {
  const image = new Image();
  // blob: URL에는 crossOrigin 설정하면 iOS Safari에서 로드 실패
  if (imageSrc.startsWith("http")) image.crossOrigin = "anonymous";
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Image load failed"));
    image.src = imageSrc;
  });

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIZE;
  canvas.height = AVATAR_SIZE;
  const ctx = canvas.getContext("2d")!;

  ctx.drawImage(
    image,
    crop.x, crop.y, crop.width, crop.height,
    0, 0, AVATAR_SIZE, AVATAR_SIZE,
  );

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("Canvas toBlob failed")),
      "image/jpeg",
      AVATAR_QUALITY,
    );
  });
}

export default function AvatarSelectSheet({ isOpen, onClose, currentAvatarUrl, teamId, nickname }: Props) {
  const { user, refreshProfile } = useAuth();
  const team = teamId ? TEAMS.find(t => t.id === teamId) : null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Selection state
  const [selected, setSelected] = useState<Selection>(null);
  const [saving, setSaving] = useState(false);

  // Crop state
  const [cropImage, setCropImage] = useState<string | null>(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedArea, setCroppedArea] = useState<Area | null>(null);
  const [uploading, setUploading] = useState(false);

  // Current custom avatar URL (if any)
  const [customAvatarUrl, setCustomAvatarUrl] = useState<string | null>(null);

  useBodyScrollLock(isOpen);

  // Sync state when sheet opens
  useEffect(() => {
    if (!isOpen) return;
    const presetKey = getPresetKey(currentAvatarUrl);
    if (presetKey) {
      setSelected(presetKey);
      setCustomAvatarUrl(null);
    } else if (isCustomAvatar(currentAvatarUrl)) {
      setSelected("custom");
      // Strip custom: prefix for display, add cache-bust
      const url = currentAvatarUrl!.slice("custom:".length);
      setCustomAvatarUrl(`${url}?t=${Date.now()}`);
    } else {
      setSelected(null);
      setCustomAvatarUrl(null);
    }
    setCropImage(null);
  }, [isOpen, currentAvatarUrl]);

  // ESC 닫기
  useEffect(() => {
    if (!isOpen) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (cropImage) {
          setCropImage(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isOpen, onClose, cropImage]);

  const onCropComplete = useCallback((_: Area, croppedAreaPixels: Area) => {
    setCroppedArea(croppedAreaPixels);
  }, []);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    setCropImage(url);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    // Reset input so same file can be re-selected
    e.target.value = "";
  };

  const handleCropConfirm = async () => {
    if (!cropImage || !croppedArea || !user) return;
    setUploading(true);

    try {
      const blob = await getCroppedBlob(cropImage, croppedArea);

      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        alert("로그인이 필요합니다");
        return;
      }

      const formData = new FormData();
      formData.append("file", new File([blob], "avatar.jpg", { type: "image/jpeg" }));

      const res = await fetch("/api/avatar/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${session.access_token}` },
        body: formData,
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error("아바타 업로드 실패:", errText);
        alert("업로드에 실패했어요. 다시 시도해주세요.");
        return;
      }

      const { url } = await res.json();
      setCustomAvatarUrl(`${url}?t=${Date.now()}`);
      setSelected("custom");
      setCropImage(null);

      await refreshProfile();
    } catch (err) {
      console.error("아바타 업로드 에러:", err);
      alert("업로드 중 오류가 발생했어요.");
    } finally {
      setUploading(false);
    }
  };

  const handleSelect = (key: Selection) => {
    if (!user || saving) return;
    setSelected(key);
  };

  const handleConfirm = async () => {
    if (!user || saving) return;
    setSaving(true);

    // custom 아바타는 crop 단계에서 이미 저장됨
    if (selected === "custom") {
      setSaving(false);
      onClose();
      return;
    }

    const avatarUrl = selected ? `preset:${selected}` : null;
    const { error } = await supabase
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", user.id);

    if (error) {
      console.error("아바타 저장 실패:", error);
      setSaving(false);
      return;
    }
    await refreshProfile();
    setSaving(false);
    onClose();
  };

  if (typeof window === "undefined") return null;

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => cropImage ? setCropImage(null) : onClose()}
            className="fixed inset-0 z-[60] bg-black/60"
          />

          {/* Sheet */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 300 }}
            className="fixed bottom-0 left-0 right-0 z-[60] mx-auto max-w-lg rounded-t-3xl bg-bg-secondary border-t border-black/10 dark:border-white/10 flex flex-col"
            style={{ maxHeight: "80dvh" }}
          >
            {/* Handle */}
            <div className="mx-auto mt-3 mb-2 h-1 w-10 rounded-full bg-text-tertiary/30" />

            {/* Header */}
            <div className="flex items-center justify-between px-5 mb-3">
              <h2 className="text-lg font-bold text-text-primary">
                {cropImage ? "사진 자르기" : "아바타 선택"}
              </h2>
              <button
                onClick={() => cropImage ? setCropImage(null) : onClose()}
                className="rounded-full p-1 hover:bg-bg-tertiary transition-colors"
              >
                <X size={22} className="text-text-secondary" />
              </button>
            </div>

            {cropImage ? (
              /* ───── Crop Mode ───── */
              <div className="flex-1 flex flex-col min-h-0">
                <div className="relative flex-1 min-h-[280px] mx-5 rounded-xl overflow-hidden bg-black">
                  <Cropper
                    image={cropImage}
                    crop={crop}
                    zoom={zoom}
                    aspect={1}
                    cropShape="round"
                    showGrid={false}
                    onCropChange={setCrop}
                    onZoomChange={setZoom}
                    onCropComplete={onCropComplete}
                  />
                </div>

                {/* Zoom slider */}
                <div className="px-8 py-3">
                  <input
                    type="range"
                    min={1}
                    max={3}
                    step={0.05}
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                    className="w-full accent-accent"
                  />
                </div>

                <div className="border-t border-black/10 dark:border-white/10 px-5 pt-3 pb-[calc(16px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] flex-shrink-0">
                  <button
                    onClick={handleCropConfirm}
                    disabled={uploading}
                    className="w-full rounded-2xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50 flex items-center justify-center gap-2"
                  >
                    {uploading ? (
                      <>
                        <Loader2 size={16} className="animate-spin" />
                        업로드 중...
                      </>
                    ) : (
                      "이 사진으로 설정"
                    )}
                  </button>
                </div>
              </div>
            ) : (
              /* ───── Select Mode ───── */
              <>
                <div
                  ref={scrollRef}
                  className="overflow-y-auto px-5 flex-1 min-h-0"
                  style={{ overscrollBehavior: "contain", paddingBottom: "16px" }}
                >
                  {/* 사진 업로드 옵션 */}
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className={`w-full mb-3 p-3 rounded-2xl flex items-center gap-3 transition-colors ${
                      selected === "custom"
                        ? "bg-accent/10 border border-accent/30"
                        : "bg-bg-glass"
                    }`}
                  >
                    {customAvatarUrl ? (
                      <img
                        src={customAvatarUrl}
                        alt="내 아바타"
                        className="w-10 h-10 rounded-full object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-10 h-10 rounded-full bg-bg-tertiary flex items-center justify-center flex-shrink-0">
                        <Camera size={18} className="text-text-tertiary" />
                      </div>
                    )}
                    <span className="text-sm font-medium text-text-primary">
                      {customAvatarUrl ? "내 사진" : "사진 업로드"}
                    </span>
                    {selected === "custom" && <Check size={18} className="ml-auto text-accent" />}
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    onChange={handleFileChange}
                    className="hidden"
                  />

                  {/* 기본(이니셜) 옵션 */}
                  <button
                    onClick={() => handleSelect(null)}
                    className={`w-full mb-4 p-3 rounded-2xl flex items-center gap-3 transition-colors ${
                      selected === null ? "bg-accent/10 border border-accent/30" : "bg-bg-glass"
                    }`}
                  >
                    <div
                      className="w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: team?.colorPrimary ?? "#6366f1" }}
                    >
                      {nickname?.charAt(0) || "?"}
                    </div>
                    <span className="text-sm font-medium text-text-primary">기본 (이니셜)</span>
                    {selected === null && <Check size={18} className="ml-auto text-accent" />}
                  </button>

                  {/* 프리셋 그리드 */}
                  <div className="grid grid-cols-4 gap-3">
                    {PRESET_AVATARS.map((avatar) => (
                      <button
                        key={avatar.key}
                        onClick={() => handleSelect(avatar.key)}
                        className={`relative flex flex-col items-center gap-1.5 p-2 rounded-xl transition-all ${
                          selected === avatar.key
                            ? "bg-accent/10 ring-2 ring-accent scale-105"
                            : "hover:bg-bg-tertiary active:scale-95"
                        }`}
                      >
                        <div className={`w-14 h-14 rounded-full overflow-hidden flex items-center justify-center p-1.5 ${
                          selected === avatar.key ? "bg-accent/20" : "bg-bg-tertiary"
                        }`}>
                          <img src={avatar.path} alt={avatar.label} className="w-full h-full" />
                        </div>
                        <span className="text-[11px] text-text-tertiary">{avatar.label}</span>
                        {selected === avatar.key && (
                          <div className="absolute -top-0.5 -right-0.5">
                            <Check size={14} className="text-accent" />
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="border-t border-black/10 dark:border-white/10 px-5 pt-3 pb-[calc(16px+var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px)))] flex-shrink-0">
                  <button
                    onClick={handleConfirm}
                    disabled={saving}
                    className="w-full rounded-2xl bg-accent py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
                  >
                    {saving ? "저장 중..." : "선택 완료"}
                  </button>
                </div>
              </>
            )}
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}
