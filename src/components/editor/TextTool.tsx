"use client";

import { useState, useEffect } from "react";
import { Type, Plus } from "lucide-react";
import type * as fabric from "fabric";

interface TextToolProps {
  canvas: fabric.Canvas | null;
  addText: (content?: string, options?: Partial<fabric.ITextProps>) => fabric.IText;
}

interface StylePreset {
  id: string;
  label: string;
  fontFamily: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
}

const STYLE_PRESETS: StylePreset[] = [
  {
    id: "meme",
    label: "밈체",
    fontFamily: "Impact, Arial Black, sans-serif",
    fill: "#FFFFFF",
    stroke: "#000000",
    strokeWidth: 3,
  },
  {
    id: "gothic",
    label: "고딕",
    fontFamily: "Pretendard Variable, Pretendard, sans-serif",
    fill: "#FFFFFF",
    stroke: "",
    strokeWidth: 0,
  },
  {
    id: "handwrite",
    label: "손글씨",
    fontFamily: "'Gamja Flower', cursive",
    fill: "#FFFFFF",
    stroke: "",
    strokeWidth: 0,
  },
];

const COLOR_PRESETS = [
  { id: "white", color: "#FFFFFF", label: "흰" },
  { id: "black", color: "#000000", label: "검" },
  { id: "red", color: "#FF453A", label: "빨" },
  { id: "blue", color: "#007AFF", label: "파" },
  { id: "yellow", color: "#FFD60A", label: "노" },
];

export default function TextTool({ canvas, addText }: TextToolProps) {
  const [activeStyle, setActiveStyle] = useState("meme");
  const [activeColor, setActiveColor] = useState("#FFFFFF");
  const [fontSize, setFontSize] = useState(40);
  const [hasSelection, setHasSelection] = useState(false);

  useEffect(() => {
    if (!canvas) return;

    const onSelect = () => {
      const obj = canvas.getActiveObject();
      if (obj && obj.type === "i-text") {
        setHasSelection(true);
        const t = obj as fabric.IText;
        setActiveColor((t.fill as string) || "#FFFFFF");
        setFontSize(t.fontSize || 40);
        const match = STYLE_PRESETS.find((p) => t.fontFamily?.includes(p.fontFamily.split(",")[0]));
        if (match) setActiveStyle(match.id);
      } else {
        setHasSelection(false);
      }
    };

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

  function applyStyle(preset: StylePreset) {
    setActiveStyle(preset.id);
    if (!canvas) return;
    const obj = canvas.getActiveObject();
    if (obj && obj.type === "i-text") {
      const t = obj as fabric.IText;
      t.set({
        fontFamily: preset.fontFamily,
        stroke: preset.stroke,
        strokeWidth: preset.strokeWidth,
      });
      canvas.renderAll();
    }
  }

  function applyColor(color: string) {
    setActiveColor(color);
    if (!canvas) return;
    const obj = canvas.getActiveObject();
    if (obj && obj.type === "i-text") {
      (obj as fabric.IText).set({ fill: color });
      canvas.renderAll();
    }
  }

  function applySize(size: number) {
    setFontSize(size);
    if (!canvas) return;
    const obj = canvas.getActiveObject();
    if (obj && obj.type === "i-text") {
      (obj as fabric.IText).set({ fontSize: size });
      canvas.renderAll();
    }
  }

  function handleAddText() {
    const preset = STYLE_PRESETS.find((p) => p.id === activeStyle) || STYLE_PRESETS[0];
    addText(undefined, {
      fontFamily: preset.fontFamily,
      fill: activeColor,
      stroke: preset.stroke,
      strokeWidth: preset.strokeWidth,
      fontSize,
    });
  }

  return (
    <div className="space-y-4 p-4">
      {/* Add text button */}
      <button
        onClick={handleAddText}
        className="flex items-center gap-2 w-full justify-center rounded-xl bg-accent/20 text-accent py-2.5 font-semibold text-sm active:scale-95 transition-transform"
      >
        <Plus size={18} />
        텍스트 추가
      </button>

      {/* Style presets */}
      <div>
        <p className="text-xs text-text-secondary mb-2">스타일</p>
        <div className="flex gap-2">
          {STYLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => applyStyle(preset)}
              className={`flex-1 py-2 rounded-lg text-sm font-medium transition-colors ${
                activeStyle === preset.id
                  ? "bg-accent text-white"
                  : "bg-bg-tertiary text-text-secondary"
              }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Color presets */}
      <div>
        <p className="text-xs text-text-secondary mb-2">색상</p>
        <div className="flex gap-3">
          {COLOR_PRESETS.map((c) => (
            <button
              key={c.id}
              onClick={() => applyColor(c.color)}
              className={`w-8 h-8 rounded-full border-2 transition-transform ${
                activeColor === c.color ? "border-accent scale-110" : "border-border"
              }`}
              style={{ backgroundColor: c.color }}
              title={c.label}
            />
          ))}
        </div>
      </div>

      {/* Size slider */}
      <div>
        <p className="text-xs text-text-secondary mb-2">
          크기 <span className="text-text-tertiary">{fontSize}px</span>
        </p>
        <input
          type="range"
          min={20}
          max={80}
          value={fontSize}
          onChange={(e) => applySize(Number(e.target.value))}
          className="w-full accent-accent"
        />
      </div>

      {hasSelection && (
        <p className="text-xs text-text-tertiary text-center">
          <Type size={12} className="inline mr-1" />
          선택된 텍스트에 스타일이 적용됩니다
        </p>
      )}
    </div>
  );
}
