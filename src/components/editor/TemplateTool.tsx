"use client";

import * as fabric from "fabric";

interface TemplateToolProps {
  canvas: fabric.Canvas | null;
  addText: (content?: string, options?: Partial<fabric.ITextProps>) => fabric.IText;
  clearObjects: () => void;
}

interface Template {
  id: string;
  label: string;
  description: string;
  icon: string;
}

const TEMPLATES: Template[] = [
  {
    id: "top-bottom",
    label: "상/하단 텍스트",
    description: "밈체 텍스트 상단+하단",
    icon: "📝",
  },
  {
    id: "caption-bar",
    label: "캡션바",
    description: "하단 검정바 + 텍스트",
    icon: "▬",
  },
  {
    id: "stadium-check",
    label: "직관인증",
    description: "날짜/구장 프레임",
    icon: "🏟️",
  },
];

export default function TemplateTool({ canvas, addText, clearObjects }: TemplateToolProps) {
  function applyTemplate(templateId: string) {
    if (!canvas) return;

    const objects = canvas.getObjects();
    if (objects.length > 0) {
      if (!confirm("기존 편집 내용이 삭제됩니다. 계속하시겠습니까?")) return;
    }
    clearObjects();

    const w = canvas.getWidth();
    const h = canvas.getHeight();

    switch (templateId) {
      case "top-bottom": {
        addText("상단 텍스트", {
          left: w / 2,
          top: h * 0.08,
          originX: "center",
          originY: "top",
          fontSize: 48,
          fontFamily: "Impact, Arial Black, sans-serif",
          fill: "#FFFFFF",
          stroke: "#000000",
          strokeWidth: 4,
          textAlign: "center",
        });
        addText("하단 텍스트", {
          left: w / 2,
          top: h * 0.88,
          originX: "center",
          originY: "bottom",
          fontSize: 48,
          fontFamily: "Impact, Arial Black, sans-serif",
          fill: "#FFFFFF",
          stroke: "#000000",
          strokeWidth: 4,
          textAlign: "center",
        });
        break;
      }
      case "caption-bar": {
        const barHeight = h * 0.15;
        const bar = new fabric.Rect({
          left: 0,
          top: h - barHeight,
          width: w,
          height: barHeight,
          fill: "rgba(0,0,0,0.85)",
          selectable: false,
          evented: false,
        });
        canvas.add(bar);

        addText("캡션을 입력하세요", {
          left: w / 2,
          top: h - barHeight / 2,
          originX: "center",
          originY: "center",
          fontSize: 28,
          fontFamily: "Pretendard Variable, Pretendard, sans-serif",
          fill: "#FFFFFF",
          stroke: "",
          strokeWidth: 0,
          textAlign: "center",
        });
        break;
      }
      case "stadium-check": {
        // Frame border
        const border = new fabric.Rect({
          left: 8,
          top: 8,
          width: w - 16,
          height: h - 16,
          fill: "transparent",
          stroke: "rgba(255,255,255,0.6)",
          strokeWidth: 3,
          rx: 12,
          ry: 12,
          selectable: false,
          evented: false,
        });
        canvas.add(border);

        // Bottom info bar
        const infoBar = new fabric.Rect({
          left: 0,
          top: h - h * 0.12,
          width: w,
          height: h * 0.12,
          fill: "rgba(0,0,0,0.7)",
          selectable: false,
          evented: false,
        });
        canvas.add(infoBar);

        const today = new Date();
        const dateStr = `${today.getFullYear()}.${String(today.getMonth() + 1).padStart(2, "0")}.${String(today.getDate()).padStart(2, "0")}`;

        addText(`${dateStr} · 잠실야구장`, {
          left: w / 2,
          top: h - h * 0.06,
          originX: "center",
          originY: "center",
          fontSize: 20,
          fontFamily: "Pretendard Variable, Pretendard, sans-serif",
          fill: "#FFFFFF",
          stroke: "",
          strokeWidth: 0,
          textAlign: "center",
        });
        break;
      }
    }

    canvas.renderAll();
  }

  return (
    <div className="p-4 space-y-3">
      <p className="text-xs text-text-secondary">템플릿 선택</p>
      <div className="grid grid-cols-3 gap-3">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            onClick={() => applyTemplate(t.id)}
            className="flex flex-col items-center gap-2 rounded-xl bg-bg-tertiary p-3 active:scale-95 transition-transform hover:bg-bg-secondary"
          >
            <span className="text-2xl">{t.icon}</span>
            <span className="text-xs font-medium text-text-primary">{t.label}</span>
            <span className="text-[10px] text-text-tertiary">{t.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
