"use client";

import { useEffect, useRef, useCallback } from "react";
import * as fabric from "fabric";

interface UseCanvasReturn {
  canvas: fabric.Canvas | null;
  loadImage: (url: string) => Promise<void>;
  exportBlob: () => Promise<File>;
  addText: (content?: string, options?: Partial<fabric.ITextProps>) => fabric.IText;
  addSvg: (svgString: string) => Promise<fabric.FabricObject>;
  addImage: (url: string) => Promise<fabric.FabricObject>;
  clearObjects: () => void;
  deleteSelected: () => boolean;
}

export function useCanvas(
  containerRef: React.RefObject<HTMLDivElement | null>
): UseCanvasReturn {
  const canvasRef = useRef<fabric.Canvas | null>(null);
  const canvasElRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || canvasRef.current) return;

    const el = document.createElement("canvas");
    container.appendChild(el);
    canvasElRef.current = el;

    const width = container.clientWidth;
    const height = Math.round(width * (4 / 3)); // default 4:3 until image loads

    const c = new fabric.Canvas(el, {
      width,
      height,
      backgroundColor: "#0A0A0B",
      selection: true,
    });

    canvasRef.current = c;

    return () => {
      c.dispose();
      canvasRef.current = null;
      if (canvasElRef.current && container.contains(canvasElRef.current)) {
        container.removeChild(canvasElRef.current);
      }
      canvasElRef.current = null;
    };
  }, [containerRef]);

  const loadImage = useCallback(async (url: string) => {
    const c = canvasRef.current;
    if (!c) return;

    const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });
    const cWidth = c.getWidth();
    const scale = cWidth / img.width;
    const newHeight = Math.round(img.height * scale);

    c.setDimensions({ width: cWidth, height: newHeight });

    img.scaleX = scale;
    img.scaleY = scale;
    img.left = 0;
    img.top = 0;
    img.originX = "left";
    img.originY = "top";
    img.selectable = false;
    img.evented = false;

    c.backgroundImage = img;
    c.renderAll();
  }, []);

  const exportBlob = useCallback(async (): Promise<File> => {
    const c = canvasRef.current;
    if (!c) throw new Error("Canvas not initialized");

    // Deselect all before export
    c.discardActiveObject();
    c.renderAll();

    return new Promise((resolve, reject) => {
      const el = c.getElement() as HTMLCanvasElement;
      el.toBlob(
        (blob) => {
          if (!blob) return reject(new Error("Export failed"));
          resolve(new File([blob], `meme-${Date.now()}.jpg`, { type: "image/jpeg" }));
        },
        "image/jpeg",
        0.9
      );
    });
  }, []);

  const addText = useCallback(
    (content?: string, options?: Partial<fabric.ITextProps>): fabric.IText => {
      const c = canvasRef.current;
      if (!c) throw new Error("Canvas not initialized");

      const text = new fabric.IText(content ?? "텍스트 입력", {
        left: c.getWidth() / 2,
        top: c.getHeight() / 2,
        originX: "center",
        originY: "center",
        fontSize: 40,
        fill: "#FFFFFF",
        fontFamily: "Impact, Arial Black, sans-serif",
        stroke: "#000000",
        strokeWidth: 3,
        textAlign: "center",
        ...options,
      });

      c.add(text);
      c.setActiveObject(text);
      c.renderAll();

      // If using a web font, re-render after it loads to avoid fallback flash
      if (options?.fontFamily) {
        const primaryFont = options.fontFamily.split(",")[0].replace(/'/g, "").trim();
        if (!document.fonts.check(`${text.fontSize}px "${primaryFont}"`)) {
          document.fonts.ready.then(() => {
            c.renderAll();
          });
        }
      }

      return text;
    },
    []
  );

  const addSvg = useCallback(
    async (svgString: string): Promise<fabric.FabricObject> => {
      const c = canvasRef.current;
      if (!c) throw new Error("Canvas not initialized");

      const objects = await fabric.loadSVGFromString(svgString);
      const group = fabric.util.groupSVGElements(
        objects.objects.filter(Boolean) as fabric.FabricObject[],
        objects.options
      );

      const targetSize = c.getWidth() * 0.25;
      const scale = targetSize / Math.max(group.width, group.height);
      group.scaleX = scale;
      group.scaleY = scale;
      group.left = c.getWidth() / 2;
      group.top = c.getHeight() / 2;
      group.originX = "center";
      group.originY = "center";

      c.add(group);
      c.setActiveObject(group);
      c.renderAll();
      return group;
    },
    []
  );

  const addImage = useCallback(
    async (url: string): Promise<fabric.FabricObject> => {
      const c = canvasRef.current;
      if (!c) throw new Error("Canvas not initialized");

      const img = await fabric.FabricImage.fromURL(url, { crossOrigin: "anonymous" });

      const targetSize = c.getWidth() * 0.25;
      const scale = targetSize / Math.max(img.width, img.height);
      img.scaleX = scale;
      img.scaleY = scale;
      img.left = c.getWidth() / 2;
      img.top = c.getHeight() / 2;
      img.originX = "center";
      img.originY = "center";

      c.add(img);
      c.setActiveObject(img);
      c.renderAll();
      return img;
    },
    []
  );

  const clearObjects = useCallback(() => {
    const c = canvasRef.current;
    if (!c) return;
    c.getObjects().forEach((obj) => c.remove(obj));
    c.renderAll();
  }, []);

  const deleteSelected = useCallback((): boolean => {
    const c = canvasRef.current;
    if (!c) return false;
    const active = c.getActiveObject();
    if (!active) return false;
    if (active instanceof fabric.ActiveSelection) {
      active.getObjects().forEach((obj) => c.remove(obj));
    } else {
      c.remove(active);
    }
    c.discardActiveObject();
    c.renderAll();
    return true;
  }, []);

  return {
    canvas: canvasRef.current,
    loadImage,
    exportBlob,
    addText,
    addSvg,
    addImage,
    clearObjects,
    deleteSelected,
  };
}
