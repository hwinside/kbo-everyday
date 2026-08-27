"use client";

import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Type, Smile, LayoutTemplate } from "lucide-react";
import type * as fabric from "fabric";
import TextTool from "./TextTool";
import StickerTool from "./StickerTool";
import TemplateTool from "./TemplateTool";

type ToolType = "text" | "sticker" | "template" | null;

interface EditorToolbarProps {
  canvas: fabric.Canvas | null;
  addText: (content?: string, options?: Partial<fabric.ITextProps>) => fabric.IText;
  addSvg: (svgString: string) => Promise<fabric.FabricObject>;
  addImage: (url: string) => Promise<fabric.FabricObject>;
  clearObjects: () => void;
}

const TOOLS: { id: ToolType; icon: typeof Type; label: string }[] = [
  { id: "text", icon: Type, label: "텍스트" },
  { id: "sticker", icon: Smile, label: "스티커" },
  { id: "template", icon: LayoutTemplate, label: "템플릿" },
];

export default function EditorToolbar({ canvas, addText, addSvg, addImage, clearObjects }: EditorToolbarProps) {
  const [activeTool, setActiveTool] = useState<ToolType>(null);

  function toggleTool(tool: ToolType) {
    setActiveTool((prev) => (prev === tool ? null : tool));
  }

  return (
    <>
      {/* Tool panel */}
      <AnimatePresence>
        {activeTool && (
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 30, stiffness: 300 }}
            className="bg-bg-secondary border-t border-border rounded-t-2xl max-h-[40vh] overflow-y-auto"
          >
            {activeTool === "text" && <TextTool canvas={canvas} addText={addText} />}
            {activeTool === "sticker" && <StickerTool addSvg={addSvg} addImage={addImage} />}
            {activeTool === "template" && (
              <TemplateTool canvas={canvas} addText={addText} clearObjects={clearObjects} />
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Tab bar */}
      <div className="flex items-center justify-around bg-bg-secondary border-t border-border py-2 px-4"
        style={{ paddingBottom: "max(var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)), 8px)" }}
      >
        {TOOLS.map(({ id, icon: Icon, label }) => (
          <button
            key={id}
            onClick={() => toggleTool(id)}
            className={`flex flex-col items-center gap-0.5 px-4 py-1.5 rounded-xl transition-colors ${
              activeTool === id
                ? "text-accent"
                : "text-text-secondary"
            }`}
          >
            <Icon size={22} />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </div>
    </>
  );
}
