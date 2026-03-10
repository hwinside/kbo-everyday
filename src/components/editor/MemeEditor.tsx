"use client";

import { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Check, Loader2, Trash2 } from "lucide-react";
import { useCanvas } from "./useCanvas";
import EditorToolbar from "./EditorToolbar";

interface MemeEditorProps {
  imageUrl: string;
  onSave: (file: File) => void;
  onCancel: () => void;
}

export default function MemeEditor({ imageUrl, onSave, onCancel }: MemeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { canvas, loadImage, exportBlob, addText, addSvg, clearObjects, deleteSelected } = useCanvas(containerRef);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);

  // Track canvas selection state
  useEffect(() => {
    if (!canvas) return;
    const onSelect = () => setHasSelection(true);
    const onDeselect = () => setHasSelection(false);
    canvas.on("selection:created", onSelect);
    canvas.on("selection:updated", onSelect);
    canvas.on("selection:cleared", onDeselect);
    return () => {
      canvas.off("selection:created", onSelect);
      canvas.off("selection:updated", onSelect);
      canvas.off("selection:cleared", onDeselect);
    };
  }, [canvas]);

  useEffect(() => {
    if (imageUrl) {
      loadImage(imageUrl).then(() => setLoaded(true));
    }
  }, [imageUrl, loadImage]);

  async function handleSave() {
    setSaving(true);
    try {
      const file = await exportBlob();
      onSave(file);
    } catch {
      alert("이미지 저장에 실패했습니다.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      initial={{ y: "100%" }}
      animate={{ y: 0 }}
      exit={{ y: "100%" }}
      transition={{ type: "spring", damping: 30, stiffness: 300 }}
      className="fixed inset-0 z-[60] bg-bg-primary flex flex-col"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2"
        style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 8px)" }}
      >
        <button onClick={onCancel} className="text-text-secondary p-2">
          <X size={24} />
        </button>
        <h2 className="text-base font-semibold text-text-primary">밈 편집</h2>
        <button
          onClick={handleSave}
          disabled={saving || !loaded}
          className="flex items-center gap-1.5 rounded-full bg-accent px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-40 transition-opacity"
        >
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
          완료
        </button>
      </div>

      {/* Delete button (shown when element selected) */}
      {hasSelection && (
        <div className="flex justify-center py-2">
          <button
            onClick={() => deleteSelected()}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-red-500/20 text-red-400 text-sm font-medium"
          >
            <Trash2 size={16} />
            선택 삭제
          </button>
        </div>
      )}

      {/* Canvas area */}
      <div className="flex-1 overflow-hidden flex items-center justify-center bg-black/40">
        <div ref={containerRef} className="w-full max-w-[100vw]" />
      </div>

      {/* Toolbar */}
      <EditorToolbar
        canvas={canvas}
        addText={addText}
        addSvg={addSvg}
        clearObjects={clearObjects}
      />
    </motion.div>
  );
}
