"use client";

import { useState, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Image as ImageIcon, XCircle } from "lucide-react";
import Image from "next/image";

interface WritePostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
  onSubmit?: (title: string, content: string, imageUrls: string[]) => Promise<void>;
}

export default function WritePost({ isOpen, onClose, teamName, onSubmit }: WritePostProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [images, setImages] = useState<{preview: string; file: File}[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleImageSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    const remaining = 5 - images.length;
    Array.from(files).slice(0, remaining).forEach((file) => {
      const preview = URL.createObjectURL(file);
      setImages((prev) => [...prev, { preview, file }]);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function removeImage(index: number) {
    setImages((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSubmit() {
    if (!title.trim() || !content.trim()) return;
    try {
      if (onSubmit) await onSubmit(title.trim(), content.trim(), []);
    } catch (e: any) {
      alert("등록 실패: " + (e.message || JSON.stringify(e)));
      return;
    }
    onClose();
    setTitle("");
    setContent("");
    setImages([]);
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary overflow-y-auto"
            style={{ maxHeight: "90vh" }}
          >
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>
            <div className="flex items-center justify-between px-5 py-3">
              <button onClick={onClose} className="text-text-secondary p-1">
                <X size={24} />
              </button>
              <h2 className="text-lg font-semibold text-text-primary">
                {teamName ? `${teamName} 글쓰기` : "글쓰기"}
              </h2>
              <button
                onClick={handleSubmit}
                disabled={!title.trim() || !content.trim()}
                className="rounded-full bg-accent px-4 py-1.5 text-base font-semibold text-white disabled:opacity-40 transition-opacity"
              >
                등록
              </button>
            </div>
            <div className="px-5 pb-8 space-y-4">
              <input
                type="text"
                placeholder="제목"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                maxLength={100}
                className="w-full rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />
              <textarea
                placeholder="내용을 입력하세요"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={6}
                className="w-full resize-none rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />
              {images.length > 0 && (
                <div className="flex gap-2 overflow-x-auto hide-scrollbar">
                  {images.map((img, i) => (
                    <div key={i} className="relative flex-shrink-0 w-20 h-20 rounded-xl overflow-hidden">
                      <Image src={img.preview} alt={`첨부 ${i + 1}`} fill className="object-cover" unoptimized />
                      <button
                        onClick={() => removeImage(i)}
                        className="absolute top-1 right-1 text-white drop-shadow-lg"
                      >
                        <XCircle size={20} fill="rgba(0,0,0,0.6)" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handleImageSelect}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={images.length >= 5}
                className="flex items-center gap-4 rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-secondary hover:text-text-primary transition-colors disabled:opacity-40"
              >
                <ImageIcon size={22} />
                사진 첨부 ({images.length}/5)
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
