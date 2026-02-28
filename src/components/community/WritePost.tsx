"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Image as ImageIcon } from "lucide-react";

interface WritePostProps {
  isOpen: boolean;
  onClose: () => void;
  teamName?: string;
}

export default function WritePost({ isOpen, onClose, teamName }: WritePostProps) {
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  function handleSubmit() {
    if (!title.trim() || !content.trim()) return;
    // TODO: Supabase 연동
    onClose();
    setTitle("");
    setContent("");
  }

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/60"
            onClick={onClose}
          />

          {/* Modal */}
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-50 rounded-t-2xl bg-bg-secondary"
            style={{ maxHeight: "90vh" }}
          >
            {/* Handle */}
            <div className="flex justify-center pt-2">
              <div className="h-1 w-10 rounded-full bg-text-tertiary" />
            </div>

            {/* Header */}
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

            {/* Form */}
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
                rows={8}
                className="w-full resize-none rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-primary placeholder:text-text-tertiary outline-none"
              />
              <button className="flex items-center gap-4 rounded-xl bg-bg-tertiary px-5 py-4 text-base text-text-secondary hover:text-text-primary transition-colors">
                <ImageIcon size={22} />
                사진 첨부 (최대 5장)
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
