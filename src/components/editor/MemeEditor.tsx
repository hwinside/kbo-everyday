"use client";

import { useRef, useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X, Check, Loader2, Trash2, FlipHorizontal2, FlipVertical2 } from "lucide-react";
import { useCanvas } from "./useCanvas";
import EditorToolbar from "./EditorToolbar";

interface MemeEditorProps {
  imageUrl: string;
  onSave: (file: File) => void;
  onCancel: () => void;
}

export default function MemeEditor({ imageUrl, onSave, onCancel }: MemeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { canvas, loadImage, exportBlob, addText, addSvg, addImage, clearObjects, deleteSelected } = useCanvas(containerRef);
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

  // Preload custom fonts so Fabric.js renders them correctly on first use
  useEffect(() => {
    const fonts = [
      new FontFace("Gamja Flower", "url(https://fonts.gstatic.com/s/gamjaflower/v22/6NUR8FiKJGBITYdP0ymr1M0O2A.woff2)", {
        style: "normal",
        weight: "400",
      }),
    ];
    fonts.forEach((font) => {
      font.load().then((loaded) => {
        document.fonts.add(loaded);
        // Re-render canvas after font loads so any existing text updates
        if (canvas) canvas.renderAll();
      }).catch(() => {/* font already loaded or unavailable */});
    });
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
        style={{ paddingTop: "max(var(--safe-area-inset-top, env(safe-area-inset-top, 0px)), 8px)" }}
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

      {/* Selection actions (shown when element selected) */}
      {hasSelection && (
        <div className="flex justify-center gap-2 py-2">
          <button
            onClick={() => {
              const obj = canvas?.getActiveObject();
              if (obj) { obj.set("flipX", !obj.flipX); canvas?.renderAll(); }
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-bg-tertiary text-text-secondary text-sm font-medium"
          >
            <FlipHorizontal2 size={16} />
            좌우
          </button>
          <button
            onClick={() => {
              const obj = canvas?.getActiveObject();
              if (obj) { obj.set("flipY", !obj.flipY); canvas?.renderAll(); }
            }}
            className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-bg-tertiary text-text-secondary text-sm font-medium"
          >
            <FlipVertical2 size={16} />
            상하
          </button>
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
        addImage={addImage}
        clearObjects={clearObjects}
      />
    </motion.div>
  );
}
