"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy, PDFPageProxy, PageViewport } from "pdfjs-dist";
import { degrees, PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { createWorker } from "tesseract.js";
import { IMAGE_ACCEPT, imagesToPdf, isImageFile } from "@/lib/images-to-pdf";
import { Button, Dropzone, Field, Notice, NumberField, Panel, Select, Stat, TextArea, TextInput } from "@/components/ui";
import { downloadBlob, formatBytes, readAsDataURL } from "@/lib/format";
import { createUuidV4 } from "@/lib/random-uuid";
import { startPdfJob, type PdfJob, type PdfJobPhase } from "@/lib/pdf-client";

type Tool = "select" | "text" | "highlight" | "rectangle" | "draw" | "image";
type MarkType = Exclude<Tool, "select">;
type OcrLanguage = "eng" | "pol" | "eng+pol";

interface SearchableExportRun {
  cancelled: boolean;
  job: PdfJob | null;
}

interface Point {
  x: number;
  y: number;
}

interface Mark {
  id: string;
  type: MarkType;
  color: string;
  x: number;
  y: number;
  x2?: number;
  y2?: number;
  text?: string;
  size?: number;
  points?: Point[];
  imageData?: string;
}

interface EditorPage {
  id: number;
  originalIndex: number;
  rotation: number;
  marks: Mark[];
}

type DraftMark = Omit<Mark, "id">;

const TOOL_OPTIONS: { value: Tool; label: string }[] = [
  { value: "select", label: "Select" },
  { value: "text", label: "Text" },
  { value: "highlight", label: "Highlight" },
  { value: "rectangle", label: "Rectangle" },
  { value: "draw", label: "Draw / sign" },
  { value: "image", label: "Place image" },
];

const COLOR_OPTIONS = [
  { value: "#ef4444", label: "Red" },
  { value: "#2563eb", label: "Blue" },
  { value: "#16a34a", label: "Green" },
  { value: "#eab308", label: "Yellow" },
  { value: "#111827", label: "Black" },
];

function pointInPdf(viewport: PageViewport, event: React.PointerEvent<SVGElement>): Point {
  const svg = event.currentTarget instanceof SVGSVGElement ? event.currentTarget : event.currentTarget.ownerSVGElement;
  if (!svg) return { x: 0, y: 0 };
  const bounds = svg.getBoundingClientRect();
  const x = ((event.clientX - bounds.left) / bounds.width) * viewport.width;
  const y = ((event.clientY - bounds.top) / bounds.height) * viewport.height;
  const [pdfX, pdfY] = viewport.convertToPdfPoint(x, y);
  return { x: pdfX, y: pdfY };
}

function viewportPoint(viewport: PageViewport, point: Point): Point {
  const [x, y] = viewport.convertToViewportPoint(point.x, point.y);
  return { x, y };
}

function getBounds(mark: Mark, viewport: PageViewport) {
  const first = viewportPoint(viewport, { x: mark.x, y: mark.y });
  const second = viewportPoint(viewport, { x: mark.x2 ?? mark.x, y: mark.y2 ?? mark.y });
  return {
    x: Math.min(first.x, second.x),
    y: Math.min(first.y, second.y),
    width: Math.abs(second.x - first.x),
    height: Math.abs(second.y - first.y),
  };
}

function moveMark(mark: Mark, dx: number, dy: number): Mark {
  return {
    ...mark,
    x: mark.x + dx,
    y: mark.y + dy,
    x2: mark.x2 === undefined ? undefined : mark.x2 + dx,
    y2: mark.y2 === undefined ? undefined : mark.y2 + dy,
    points: mark.points?.map((point) => ({ x: point.x + dx, y: point.y + dy })),
  };
}

function PageThumbnail({
  document,
  page,
  active,
  onClick,
  onDragStart,
  onDrop,
}: {
  document: PDFDocumentProxy;
  page: EditorPage;
  active: boolean;
  onClick: () => void;
  onDragStart: () => void;
  onDrop: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    const render = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const source = await document.getPage(page.originalIndex + 1);
      if (cancelled) return;
      const scale = Math.min(0.24, 72 / source.getViewport({ scale: 1 }).width);
      const viewport = source.getViewport({ scale, rotation: (source.rotate + page.rotation) % 360 });
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = source.render({ canvas, canvasContext: context, viewport });
      try {
        await renderTask.promise;
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) throw error;
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page.originalIndex, page.rotation]);

  return (
    <button
      autoComplete="off"
      type="button"
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); onDrop(); }}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={`flex w-full items-center gap-3 rounded-lg border p-2 text-left transition-colors ${active ? "border-accent bg-accent/10" : "border-line bg-surface hover:border-line-strong"}`}
    >
      <span className="flex h-24 w-17 shrink-0 items-center justify-center overflow-hidden rounded border border-line bg-white">
        <canvas ref={canvasRef} className="max-h-24 max-w-full object-contain" />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink">Page {page.originalIndex + 1}</span>
        {page.rotation ? <span className="text-xs text-muted">Rotated {page.rotation}°</span> : null}
        {page.marks.length ? <span className="block text-xs text-accent">{page.marks.length} mark{page.marks.length === 1 ? "" : "s"}</span> : null}
      </span>
    </button>
  );
}

function PdfPageCanvas({
  document,
  page,
  zoom,
  tool,
  color,
  text,
  textSize,
  imageData,
  selectedMark,
  onAddMark,
  onSelectMark,
  onMoveMark,
}: {
  document: PDFDocumentProxy;
  page: EditorPage;
  zoom: number;
  tool: Tool;
  color: string;
  text: string;
  textSize: number;
  imageData: string | null;
  selectedMark: string | null;
  onAddMark: (mark: DraftMark) => void;
  onSelectMark: (id: string) => void;
  onMoveMark: (id: string, dx: number, dy: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageProxy, setPageProxy] = useState<PDFPageProxy | null>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [draft, setDraft] = useState<DraftMark | null>(null);
  const [draggedMark, setDraggedMark] = useState<{ mark: Mark; start: Point; delta: Point } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy["render"]> | null = null;
    const render = async () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const source = await document.getPage(page.originalIndex + 1);
      if (cancelled) return;
      const view = source.getViewport({ scale: zoom, rotation: (source.rotate + page.rotation) % 360 });
      canvas.width = Math.ceil(view.width);
      canvas.height = Math.ceil(view.height);
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = source.render({ canvas, canvasContext: context, viewport: view });
      try {
        await renderTask.promise;
        if (!cancelled) {
          setPageProxy(source);
          setViewport(view);
        }
      } catch (error) {
        if (!cancelled && !(error instanceof Error && error.name === "RenderingCancelledException")) throw error;
      }
    };
    void render();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [document, page.originalIndex, page.rotation, zoom]);

  const addAt = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!viewport || tool === "select") return;
    const at = pointInPdf(viewport, event);
    if (tool === "text") {
      onAddMark({ type: "text", color, x: at.x, y: at.y, text: text.trim() || "Text", size: textSize });
      return;
    }
    if (tool === "image") {
      if (imageData) onAddMark({ type: "image", color, x: at.x, y: at.y, x2: at.x + 120, y2: at.y + 80, imageData });
      return;
    }
    setDraft({
      type: tool,
      color,
      x: at.x,
      y: at.y,
      x2: at.x,
      y2: at.y,
      points: tool === "draw" ? [at] : undefined,
    });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const updateDraft = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!draft || !viewport) return;
    const at = pointInPdf(viewport, event);
    setDraft((current) => current
      ? current.type === "draw"
        ? { ...current, points: [...(current.points ?? []), at] }
        : { ...current, x2: at.x, y2: at.y }
      : null);
  };

  const finishDraft = () => {
    if (draggedMark) {
      if (draggedMark.delta.x !== 0 || draggedMark.delta.y !== 0) {
        onMoveMark(draggedMark.mark.id, draggedMark.delta.x, draggedMark.delta.y);
      }
      setDraggedMark(null);
      if (draggedMark.delta.x !== 0 || draggedMark.delta.y !== 0) return;
    }
    if (draft) {
      if (draft.type === "draw" ? (draft.points?.length ?? 0) > 1 : Math.hypot((draft.x2 ?? draft.x) - draft.x, (draft.y2 ?? draft.y) - draft.y) > 2) {
        onAddMark(draft);
      }
    }
    setDraft(null);
  };

  const beginMarkDrag = (event: React.PointerEvent<SVGElement>, mark: Mark) => {
    event.stopPropagation();
    onSelectMark(mark.id);
    if (tool !== "select" || !viewport) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (!svg) return;
    svg.setPointerCapture(event.pointerId);
    setDraggedMark({ mark, start: pointInPdf(viewport, event), delta: { x: 0, y: 0 } });
  };
  const updatePointer = (event: React.PointerEvent<SVGSVGElement>) => {
    if (draggedMark && viewport) {
      const at = pointInPdf(viewport, event);
      setDraggedMark((current) => current ? { ...current, delta: { x: at.x - current.start.x, y: at.y - current.start.y } } : null);
      return;
    }
    updateDraft(event);
  };
  const visibleMarks = page.marks.map((mark) => draggedMark?.mark.id === mark.id
    ? moveMark(mark, draggedMark.delta.x, draggedMark.delta.y)
    : mark);
  if (draft) visibleMarks.push({ ...draft, id: "draft" } as Mark);

  return (
    <div className="relative mx-auto w-fit overflow-hidden bg-white shadow-xl">
      <canvas ref={canvasRef} className="block h-auto" />
      {viewport ? (
        <svg
          tabIndex={0}
          aria-label={`PDF page ${page.originalIndex + 1}; focus here to use editor shortcuts`}
          className={`absolute inset-0 h-full w-full touch-none ${tool === "select" ? "cursor-move" : "cursor-crosshair"}`}
          viewBox={`0 0 ${viewport.width} ${viewport.height}`}
          preserveAspectRatio="none"
          onPointerDown={addAt}
          onPointerMove={updatePointer}
          onPointerUp={finishDraft}
          onPointerCancel={finishDraft}
        >
          {visibleMarks.map((mark) => {
            const selected = selectedMark === mark.id;
            if (mark.type === "text") {
              const at = viewportPoint(viewport, { x: mark.x, y: mark.y });
              return (
                <g key={mark.id} onPointerDown={(event) => beginMarkDrag(event, mark)}>
                  {selected ? <rect x={at.x - 3} y={at.y - (mark.size ?? 18) * zoom * 1.25} width={Math.max((mark.text?.length ?? 4) * (mark.size ?? 18) * zoom * 0.55, 48 * zoom)} height={(mark.size ?? 18) * zoom * 1.5} fill="none" stroke="#2563eb" strokeDasharray="4 3" /> : null}
                  <text x={at.x} y={at.y} fill={mark.color} fontSize={(mark.size ?? 18) * zoom} fontFamily="Arial, sans-serif">{mark.text}</text>
                </g>
              );
            }
            if (mark.type === "draw") {
              const points = (mark.points ?? []).map((point) => viewportPoint(viewport, point));
              const path = points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
              return <path key={mark.id} d={path} fill="none" stroke={mark.color} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" onPointerDown={(event) => beginMarkDrag(event, mark)} />;
            }
            const bounds = getBounds(mark, viewport);
            if (mark.type === "image" && mark.imageData) {
              return <image key={mark.id} href={mark.imageData} x={bounds.x} y={bounds.y} width={Math.max(8, bounds.width)} height={Math.max(8, bounds.height)} preserveAspectRatio="none" onPointerDown={(event) => beginMarkDrag(event, mark)} />;
            }
            return (
              <rect
                key={mark.id}
                x={bounds.x}
                y={bounds.y}
                width={Math.max(bounds.width, 2)}
                height={Math.max(bounds.height, 2)}
                fill={mark.type === "highlight" ? mark.color : "transparent"}
                fillOpacity={mark.type === "highlight" ? 0.32 : 0}
                stroke={mark.color}
                strokeWidth={selected ? 3 : 2}
                strokeDasharray={selected ? "5 3" : undefined}
                onPointerDown={(event) => beginMarkDrag(event, mark)}
              />
            );
          })}
        </svg>
      ) : null}
      <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-2 py-0.5 font-mono text-[10px] text-white">
        {pageProxy ? `Page ${page.originalIndex + 1}` : "Rendering…"}
      </span>
    </div>
  );
}

export default function PdfEditor() {
  const [file, setFile] = useState<File | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<EditorPage[]>([]);
  const [history, setHistory] = useState<EditorPage[][]>([]);
  const [redoHistory, setRedoHistory] = useState<EditorPage[][]>([]);
  const [activePageId, setActivePageId] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [fitToWidth, setFitToWidth] = useState(true);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(COLOR_OPTIONS[0].value);
  const [text, setText] = useState("Text");
  const [textSize, setTextSize] = useState(18);
  const [imageData, setImageData] = useState<string | null>(null);
  const [selectedMark, setSelectedMark] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [language, setLanguage] = useState<OcrLanguage>("eng");
  const [ocrText, setOcrText] = useState("");
  const [ocrProgress, setOcrProgress] = useState<{ label: string; value: number } | null>(null);
  const [ocrDone, setOcrDone] = useState<string | null>(null);
  const [deskew, setDeskew] = useState(true);
  const [rotatePages, setRotatePages] = useState(true);
  const [serverProgress, setServerProgress] = useState<string | null>(null);
  const [serverResult, setServerResult] = useState<string | null>(null);
  const serverRun = useRef<SearchableExportRun | null>(null);
  const cancelOcr = useRef(false);
  const ocrPos = useRef({ index: 0, total: 0 });
  /** Pixel width of each page's source image when the document was built from images (OCR reads at that resolution). */
  const nativeWidths = useRef<number[]>([]);
  const draggedPage = useRef<number | null>(null);
  const canvasAreaRef = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [copiedMark, setCopiedMark] = useState<Mark | null>(null);
  const activePage = pages.find((page) => page.id === activePageId) ?? null;
  const activeIndex = activePage ? pages.indexOf(activePage) : -1;
  const activeOriginalIndex = activePage?.originalIndex;
  const activePageRotation = activePage?.rotation;
  const availablePages = useMemo(() => pages, [pages]);
  const selectedMarkData = activePage?.marks.find((mark) => mark.id === selectedMark) ?? null;

  useEffect(() => () => {
    const run = serverRun.current;
    serverRun.current = null;
    if (run) {
      run.cancelled = true;
      void run.job?.cancel();
    }
  }, []);

  useEffect(() => {
    if (!fitToWidth || activeOriginalIndex === undefined || activePageRotation === undefined || !pdf || !canvasAreaRef.current) return;
    let cancelled = false;
    const fit = async () => {
      const source = await pdf.getPage(activeOriginalIndex + 1);
      if (cancelled || !canvasAreaRef.current) return;
      const pageViewport = source.getViewport({ scale: 1, rotation: (source.rotate + activePageRotation) % 360 });
      const availableWidth = canvasAreaRef.current.clientWidth - 32;
      if (availableWidth > 0 && pageViewport.width > 0) {
        setZoom(Number(Math.max(0.45, Math.min(3, availableWidth / pageViewport.width)).toFixed(2)));
      }
    };
    const observer = new ResizeObserver(() => { void fit(); });
    observer.observe(canvasAreaRef.current);
    void fit();
    return () => { cancelled = true; observer.disconnect(); };
  }, [activePage?.id, activeOriginalIndex, activePageRotation, fitToWidth, pdf]);

  const loadFile = useCallback(async (incoming: File[]) => {
    if (busy || serverRun.current) return;
    const first = incoming[0];
    if (!first) return;
    const isPdf = (f: File) => f.type === "application/pdf" || f.name.toLowerCase().endsWith(".pdf");
    const images = incoming.filter(isImageFile);
    if (!isPdf(first) && images.length !== incoming.length) {
      setError("Choose a PDF, or one or more images (PNG, JPEG, WebP).");
      return;
    }
    const total = isPdf(first) ? first.size : images.reduce((n, f) => n + f.size, 0);
    if (total > 200 * 1024 * 1024) {
      setError("This editor is capped at 200 MB per document to keep browser memory bounded.");
      return;
    }
    setBusy(true);
    setError(null);
    setNotice(null);
    setOcrText("");
    setOcrDone(null);
    setServerResult(null);
    try {
      let picked = first;
      let widths: number[] = [];
      if (!isPdf(first)) {
        setNotice(`Converting ${images.length} image${images.length === 1 ? "" : "s"} to PDF pages in this browser…`);
        const built = await imagesToPdf(images);
        widths = built.nativeWidths;
        picked = new File([new Uint8Array(built.bytes)], `${safeStem(first.name)}.pdf`, { type: "application/pdf" });
      }
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const data = new Uint8Array(await picked.arrayBuffer());
      const loaded = await pdfjs.getDocument({ data }).promise;
      if (loaded.numPages < 1) throw new Error("This PDF has no pages.");
      nativeWidths.current = widths;
      setPdf(loaded);
      setFile(picked);
      const initialPages = Array.from({ length: loaded.numPages }, (_, index) => ({
        id: index,
        originalIndex: index,
        rotation: 0,
        marks: [],
      }));
      setPages(initialPages);
      setHistory([]);
      setRedoHistory([]);
      setActivePageId(initialPages[0]?.id ?? null);
      setZoom(1);
      setFitToWidth(true);
      setSelectedMark(null);
      const pagesLoaded = `${loaded.numPages} page${loaded.numPages === 1 ? "" : "s"} loaded in this browser.`;
      setNotice(widths.length ? `${pagesLoaded} Built from ${widths.length} image${widths.length === 1 ? "" : "s"}: run OCR below, or Export edited PDF to keep it as a PDF.` : isPdf(first) && incoming.length > 1 ? `${pagesLoaded} Only the first PDF is opened.` : pagesLoaded);
    } catch (reason) {
      setPdf(null);
      setFile(null);
      setPages([]);
      setError(reason instanceof Error ? reason.message : "Could not open this PDF.");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  const updatePages = useCallback((update: (current: EditorPage[]) => EditorPage[]) => {
    if (serverRun.current) return;
    setHistory((items) => [...items.slice(-19), pages]);
    setPages(update);
    setRedoHistory([]);
  }, [pages]);

  const undo = useCallback(() => {
    if (serverRun.current) return;
    const previous = history[history.length - 1];
    if (!previous) return;
    setPages(previous);
    setHistory(history.slice(0, -1));
    setRedoHistory((items) => [...items, pages]);
    if (!previous.some((page) => page.id === activePageId)) setActivePageId(previous[0]?.id ?? null);
    setSelectedMark(null);
  }, [activePageId, history, pages]);

  const redo = useCallback(() => {
    if (serverRun.current) return;
    const next = redoHistory[redoHistory.length - 1];
    if (!next) return;
    setPages(next);
    setRedoHistory(redoHistory.slice(0, -1));
    setHistory((items) => [...items.slice(-19), pages]);
    if (!next.some((page) => page.id === activePageId)) setActivePageId(next[0]?.id ?? null);
    setSelectedMark(null);
  }, [activePageId, pages, redoHistory]);

  const addMark = useCallback((draft: DraftMark) => {
    if (!activePage) return;
    const mark: Mark = { ...draft, id: createUuidV4() };
    updatePages((current) => current.map((page) => page.id === activePage.id ? { ...page, marks: [...page.marks, mark] } : page));
    setSelectedMark(mark.id);
    setNotice("Mark added. Export to bake edits into a new PDF.");
  }, [activePage, updatePages]);

  const selectMark = useCallback((id: string) => {
    setSelectedMark(id);
    const mark = activePage?.marks.find((item) => item.id === id);
    if (mark?.type === "text") {
      setText(mark.text ?? "");
      setTextSize(mark.size ?? 18);
    }
  }, [activePage]);

  const updateSelectedText = useCallback(() => {
    if (!activePage || selectedMarkData?.type !== "text") return;
    updatePages((current) => current.map((page) => page.id === activePage.id
      ? { ...page, marks: page.marks.map((mark) => mark.id === selectedMarkData.id
        ? { ...mark, text: text.trim() || "Text", size: textSize }
        : mark) }
      : page));
    setNotice("Selected text updated.");
  }, [activePage, selectedMarkData, text, textSize, updatePages]);

  const moveSelectedMark = useCallback((id: string, dx: number, dy: number) => {
    if (!activePage) return;
    updatePages((current) => current.map((page) => page.id === activePage.id
      ? { ...page, marks: page.marks.map((mark) => mark.id === id ? moveMark(mark, dx, dy) : mark) }
      : page));
    setNotice("Mark moved.");
  }, [activePage, updatePages]);

  const deleteSelectedMark = useCallback(() => {
    if (!activePage || !selectedMark) return;
    updatePages((current) => current.map((page) => page.id === activePage.id
      ? { ...page, marks: page.marks.filter((mark) => mark.id !== selectedMark) }
      : page));
    setSelectedMark(null);
  }, [activePage, selectedMark, updatePages]);

  const copySelectedMark = useCallback(() => {
    setCopiedMark(selectedMarkData);
    if (selectedMarkData) setNotice("Mark copied. Paste inside the editor to duplicate it.");
  }, [selectedMarkData]);

  const pasteMark = useCallback(() => {
    if (!activePage || !copiedMark) return;
    const source = copiedMark;
    const pasted: Mark = {
      ...source,
      id: createUuidV4(),
      x: source.x + 18,
      y: source.y - 18,
      x2: source.x2 === undefined ? undefined : source.x2 + 18,
      y2: source.y2 === undefined ? undefined : source.y2 - 18,
      points: source.points?.map((point) => ({ x: point.x + 18, y: point.y - 18 })),
    };
    updatePages((current) => current.map((page) => page.id === activePage.id ? { ...page, marks: [...page.marks, pasted] } : page));
    setSelectedMark(pasted.id);
    setNotice("Mark pasted.");
  }, [activePage, copiedMark, updatePages]);

  const handleEditorKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (busy || serverRun.current) return;
    const target = event.target;
    if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
    const key = event.key.toLowerCase();
    const command = event.ctrlKey || event.metaKey;
    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (command && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (command && key === "c" && selectedMarkData) {
      event.preventDefault();
      copySelectedMark();
      return;
    }
    if (command && key === "v" && copiedMark) {
      event.preventDefault();
      pasteMark();
      return;
    }
    if ((key === "delete" || key === "backspace") && selectedMark) {
      event.preventDefault();
      deleteSelectedMark();
    } else if (key === "escape") {
      setSelectedMark(null);
      setTool("select");
    } else if (key === "pageup" && activeIndex > 0) {
      event.preventDefault();
      setActivePageId(availablePages[activeIndex - 1].id);
      setSelectedMark(null);
    } else if (key === "pagedown" && activeIndex >= 0 && activeIndex < availablePages.length - 1) {
      event.preventDefault();
      setActivePageId(availablePages[activeIndex + 1].id);
      setSelectedMark(null);
    }
  }, [activeIndex, availablePages, busy, copiedMark, copySelectedMark, deleteSelectedMark, pasteMark, redo, selectedMark, selectedMarkData, undo]);

  const rotatePage = useCallback((delta: number) => {
    if (!activePage) return;
    updatePages((current) => current.map((page) => page.id === activePage.id
      ? { ...page, rotation: (page.rotation + delta + 360) % 360 }
      : page));
  }, [activePage, updatePages]);

  const deletePage = useCallback(() => {
    if (!activePage) return;
    if (availablePages.length <= 1) {
      setError("Keep at least one page in the exported document.");
      return;
    }
    const next = availablePages.filter((page) => page.id !== activePage.id);
    updatePages((current) => current.filter((page) => page.id !== activePage.id));
    setActivePageId(next[Math.min(activeIndex, next.length - 1)]?.id ?? null);
    setSelectedMark(null);
  }, [activeIndex, activePage, availablePages, updatePages]);

  const reorderPages = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return;
    updatePages((current) => {
      const from = current.findIndex((page) => page.id === fromId);
      const to = current.findIndex((page) => page.id === toId);
      if (from < 0 || to < 0) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, [updatePages]);

  const exportPdf = useCallback(async () => {
    if (!file || !pages.length || busy || serverRun.current) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const blob = await serializeEditedPdf(file, pages);
      downloadBlob(blob, `${safeStem(file.name)}-edited.pdf`);
      setNotice(`Exported ${pages.length} page${pages.length === 1 ? "" : "s"}. The original file is unchanged.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not export this PDF.");
    } finally {
      setBusy(false);
    }
  }, [busy, file, pages]);

  const exportSearchablePdf = useCallback(async () => {
    if (!file || !pages.length || busy || serverRun.current) return;
    const run: SearchableExportRun = { cancelled: false, job: null };
    serverRun.current = run;
    setBusy(true);
    setError(null);
    setNotice(null);
    setServerResult(null);
    setServerProgress("Preparing current edited PDF…");
    try {
      if (pages.length > 20) throw new Error("Searchable PDF supports up to 20 pages. Remove pages here, or use Extract / Split first.");
      const blob = await serializeSearchablePdf(file, pages, () => run.cancelled || serverRun.current !== run);
      if (blob.size > 50 * 1024 * 1024) throw new Error("Searchable PDF supports up to 50 MB. Split or reduce the scan first.");
      if (run.cancelled || serverRun.current !== run) return;
      const form = new FormData();
      form.set("action", "ocr");
      form.set("params", JSON.stringify({ language, deskew, rotatePages }));
      form.append("file", blob, `${safeStem(file.name)}-edited.pdf`);
      const onPhase = (phase: PdfJobPhase) => {
        if (run.cancelled || serverRun.current !== run) return;
        setServerProgress(phase.kind === "uploading" ? "Sending edited PDF to this app's server…"
          : phase.kind === "queued" ? `Searchable PDF queued (${phase.ahead ? `${phase.ahead} ahead` : "next up"})…`
          : "Creating searchable PDF on this app's server…");
      };
      run.job = startPdfJob(form, onPhase);
      const outcome = await run.job.result;
      if (run.cancelled || serverRun.current !== run) return;
      if (outcome.kind === "cancelled") {
        run.cancelled = true;
        return;
      }
      if (outcome.kind !== "file") throw new Error("The OCR server did not return a PDF.");
      // A blob-anchor download is also captured by the assistant for file chaining.
      const filename = `${safeStem(file.name)}-searchable.pdf`;
      downloadBlob(outcome.blob, filename);
      setServerResult(`Searchable PDF downloaded: ${filename} · ${formatBytes(outcome.blob.size)}. The original is unchanged.`);
    } catch (reason) {
      if (!run.cancelled && serverRun.current === run) {
        setError(reason instanceof Error ? reason.message : "Could not create a searchable PDF.");
      }
    } finally {
      if (serverRun.current === run) {
        serverRun.current = null;
        setServerProgress(null);
        setBusy(false);
        if (run.cancelled) setServerResult("Searchable PDF cancelled. Your edits are kept; you can retry.");
      }
    }
  }, [busy, deskew, file, language, pages, rotatePages]);

  const cancelSearchablePdf = useCallback(() => {
    const run = serverRun.current;
    if (!run || run.cancelled) return;
    run.cancelled = true;
    setServerProgress("Cancelling searchable PDF…");
    void run.job?.cancel();
  }, []);

  const runOcr = useCallback(async (allPages: boolean) => {
    if (!pdf || busy || serverRun.current) return;
    cancelOcr.current = false;
    setBusy(true);
    setOcrText("");
    setOcrDone(null);
    setError(null);
    ocrPos.current = { index: 0, total: 0 };
    setOcrProgress({ label: "Starting local OCR…", value: 0 });
    try {
      const worker = await createWorker(language, 1, {
        workerPath: "/ocr/worker.min.js",
        corePath: "/ocr/core",
        langPath: "/ocr/lang",
        gzip: true,
        cacheMethod: "write",
        logger: (message) => {
          const { index, total } = ocrPos.current;
          const recognizing = message.status === "recognizing text";
          setOcrProgress({
            label: total ? `Page ${index + 1} of ${total}: ${message.status}` : message.status,
            value: total ? (index + (recognizing ? message.progress : 0)) / total : message.progress,
          });
        },
      });
      try {
        const targets = allPages ? availablePages : activePage ? [activePage] : [];
        const chunks: string[] = [];
        ocrPos.current = { index: 0, total: targets.length };
        for (const [index, target] of targets.entries()) {
          if (cancelOcr.current) break;
          const source = await pdf.getPage(target.originalIndex + 1);
          // Pages built from images are read at the image's own resolution (2x-4x the page size), PDFs at 2x.
          const native = nativeWidths.current[target.originalIndex];
          const scale = native ? Math.min(4, Math.max(2, native / source.getViewport({ scale: 1 }).width)) : 2;
          const viewport = source.getViewport({ scale, rotation: (source.rotate + target.rotation) % 360 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Canvas 2D is unavailable for OCR.");
          await source.render({ canvas, canvasContext: context, viewport }).promise;
          ocrPos.current = { index, total: targets.length };
          setOcrProgress({ label: `Recognizing page ${index + 1} of ${targets.length}…`, value: index / Math.max(1, targets.length) });
          const result = await worker.recognize(canvas);
          chunks.push(`--- Page ${target.originalIndex + 1} ---\n${result.data.text.trim()}`);
          setOcrText(chunks.join("\n\n"));
          canvas.width = 0;
          canvas.height = 0;
        }
        setOcrProgress(null);
        const wordCount = chunks.join(" ").split(/\s+/).filter(Boolean).length;
        setOcrDone(`${cancelOcr.current ? "OCR stopped after" : "OCR finished:"} ${chunks.length} page${chunks.length === 1 ? "" : "s"}, ${wordCount} words.`);
        setNotice(cancelOcr.current ? "OCR stopped. Completed pages are kept below." : `OCR finished for ${chunks.length} page${chunks.length === 1 ? "" : "s"}.`);
      } finally {
        await worker.terminate();
      }
    } catch (reason) {
      setOcrProgress(null);
      setError(reason instanceof Error ? reason.message : "OCR failed. Check that the local OCR assets are available.");
    } finally {
      setBusy(false);
    }
  }, [activePage, availablePages, busy, language, pdf]);

  const chooseImage = useCallback(async (picked: File | undefined) => {
    if (!picked) return;
    if (picked.type !== "image/png" && picked.type !== "image/jpeg") {
      setError("Place images as PNG or JPEG.");
      return;
    }
    try {
      setImageData(await readAsDataURL(picked));
      setTool("image");
      setError(null);
      setNotice("Click on the page to place the image.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not read this image.");
    }
  }, []);

  const currentOcrName = file ? `${safeStem(file.name)}-ocr.txt` : "ocr.txt";

  return (
    <div
      className="space-y-4 outline-none"
      tabIndex={-1}
      aria-label="PDF editor; keyboard shortcuts are active only while interacting here"
      onKeyDown={handleEditorKeyDown}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest("button, input, textarea, select, [contenteditable='true']")) return;
        event.currentTarget.focus({ preventScroll: true });
      }}
    >
      <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-end">
        <Dropzone accept={`application/pdf,.pdf,${IMAGE_ACCEPT}`} multiple disabled={busy} hint="A PDF up to 200 MB, or scans/photos (PNG, JPEG, WebP: one page each) — editing and text OCR stay in this browser; searchable PDF export uses this app’s server" onFiles={(files) => void loadFile(files)} />
        {file ? (
          <div className="flex flex-wrap items-center gap-2">
            <Stat label="Document" value={file.name} />
            <Stat label="Size" value={formatBytes(file.size)} />
            <Button variant="primary" disabled={busy || !pages.length} onClick={() => void exportPdf()}>{busy ? "Working…" : "Export edited PDF"}</Button>
          </div>
        ) : null}
      </div>

      {error ? <Notice tone="error">{error}</Notice> : null}
      {notice ? <Notice tone="good">{notice}</Notice> : null}

      {file ? (
        <Panel title="Searchable PDF · server">
          <div className="space-y-3">
            <Notice>Uploads the current edited document to this app’s local server for OCRmyPDF processing, not a cloud OCR service. Includes the current page order, rotations and marks. The original stays untouched.</Notice>
            <div className="flex flex-wrap items-end gap-4">
              <Field label="Searchable PDF language">
                <Select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as OcrLanguage)}>
                  <option value="eng">English</option>
                  <option value="pol">Polish</option>
                  <option value="eng+pol">English + Polish</option>
                </Select>
              </Field>
              <label className="flex items-center gap-2 py-2 text-sm text-muted">
                <input type="checkbox" checked={deskew} disabled={busy} onChange={(event) => setDeskew(event.target.checked)} className="accent-accent" />
                Deskew scanned pages
              </label>
              <label className="flex items-center gap-2 py-2 text-sm text-muted">
                <input type="checkbox" checked={rotatePages} disabled={busy} onChange={(event) => setRotatePages(event.target.checked)} className="accent-accent" />
                Auto-rotate pages
              </label>
              <Button variant="primary" disabled={busy || !pages.length} onClick={() => void exportSearchablePdf()}>Searchable PDF (server)</Button>
            </div>
            <p className="text-xs text-faint">Up to 20 pages / 50 MB. Pages with editor marks are flattened to images and re-recognized so added text cannot hide a scan from OCR. Untouched pages that already contain text are kept as-is. Deskew straightens tilted scans; auto-rotate can override manual rotation. Turn it off to keep your chosen orientation, and review the result.</p>
            {serverProgress ? (
              <div className="flex flex-wrap items-center gap-3">
                <p role="status" className="text-sm text-muted">{serverProgress}</p>
                <Button onClick={cancelSearchablePdf} disabled={serverProgress.startsWith("Cancelling")}>Cancel searchable PDF</Button>
              </div>
            ) : null}
            {serverResult ? <p role="status" className="text-sm text-muted">{serverResult}</p> : null}
          </div>
        </Panel>
      ) : null}

      {!file ? (
        <Panel title="PDF editor">
          <div className="py-10 text-center">
            <p className="text-lg font-medium text-ink">Open a PDF to start editing</p>
            <p className="mt-2 text-sm text-muted">Reorder, rotate, or remove pages; add text, highlights, shapes, freehand marks, signatures, and images; run OCR in English or Polish.</p>
            <p className="mt-1 text-sm text-muted">Scans or photos (PNG, JPEG, WebP) open as pages too: OCR them, or export them as one PDF.</p>
          </div>
        </Panel>
      ) : (
        <div inert={Boolean(serverProgress)} aria-busy={Boolean(serverProgress)} className={`grid gap-3 lg:grid-cols-[180px_minmax(0,1fr)] ${serverProgress ? "opacity-60" : ""}`}>
          <Panel title={`Pages · ${availablePages.length}`} bodyClassName="p-2">
            <div className="max-h-[72vh] space-y-2 overflow-y-auto pr-1">
              {availablePages.map((page) => (
                <PageThumbnail
                  key={page.id}
                  document={pdf!}
                  page={page}
                  active={activePageId === page.id}
                  onClick={() => { setActivePageId(page.id); setSelectedMark(null); }}
                  onDragStart={() => { draggedPage.current = page.id; }}
                  onDrop={() => {
                    if (draggedPage.current !== null) reorderPages(draggedPage.current, page.id);
                    draggedPage.current = null;
                  }}
                />
              ))}
            </div>
            <p className="mt-2 px-1 text-[11px] text-faint">Drag page cards to reorder.</p>
          </Panel>

          <div className="min-w-0 space-y-3">
            <Panel title="Edit page" right={activePage ? <span className="font-mono text-xs text-faint">{activeIndex + 1} / {availablePages.length}</span> : null} bodyClassName="p-2 sm:p-3">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5">
                  <Button size="sm" disabled={busy || history.length === 0} onClick={undo}>Undo</Button>
                  <Button size="sm" disabled={busy || redoHistory.length === 0} onClick={redo}>Redo</Button>
                  <Button size="sm" disabled={!activePage || busy} onClick={() => rotatePage(270)}>↶ Rotate</Button>
                  <Button size="sm" disabled={!activePage || busy} onClick={() => rotatePage(90)}>↻ Rotate</Button>
                  <Button size="sm" disabled={!activePage || busy || availablePages.length <= 1} onClick={deletePage}>Delete page</Button>
                  <Button size="sm" disabled={!selectedMark || busy} onClick={deleteSelectedMark}>Delete mark</Button>
                  <Button size="sm" disabled={!selectedMarkData || busy} onClick={copySelectedMark}>Copy mark</Button>
                  <Button size="sm" disabled={!copiedMark || !activePage || busy} onClick={pasteMark}>Paste mark</Button>
                </div>
                <div className="flex items-center gap-1.5">
                  <Button size="sm" disabled={zoom <= 0.45} aria-label="Zoom out" onClick={() => { setFitToWidth(false); setZoom((value) => Math.max(0.45, Number((value - 0.1).toFixed(2)))); }}>−</Button>
                  <span className="w-12 text-center font-mono text-xs text-muted">{Math.round(zoom * 100)}%</span>
                  <Button size="sm" disabled={zoom >= 3} aria-label="Zoom in" onClick={() => { setFitToWidth(false); setZoom((value) => Math.min(3, Number((value + 0.1).toFixed(2)))); }}>+</Button>
                  <Button size="sm" aria-pressed={fitToWidth} onClick={() => setFitToWidth(true)}>Fit width</Button>
                </div>
              </div>
              {activePage && pdf ? (
                <div ref={canvasAreaRef} className="max-h-[76vh] overflow-auto rounded-lg bg-[#272a31] p-2 sm:p-4">
                  <PdfPageCanvas
                    document={pdf}
                    page={activePage}
                    zoom={zoom}
                    tool={tool}
                    color={color}
                    text={text}
                    textSize={textSize}
                    imageData={imageData}
                    selectedMark={selectedMark}
                    onAddMark={addMark}
                    onSelectMark={selectMark}
                    onMoveMark={moveSelectedMark}
                  />
                </div>
              ) : <p className="p-8 text-center text-sm text-muted">Choose a page.</p>}
            </Panel>
            <Notice>Text is added as an overlay; it does not rewrite existing PDF text. White overlays are not secure redaction. The source stays untouched until you export.</Notice>
            <Notice>Shortcuts work only while focus is inside this editor: Ctrl/Cmd+Z undo, Ctrl/Cmd+Shift+Z or Y redo, Ctrl/Cmd+C/V copy/paste the selected mark inside the editor, Delete removes it, Esc returns to Select, and Page Up/Down changes pages. Text fields keep their native shortcuts. Existing PDF text cannot be rewritten by this editor.</Notice>
          </div>

          <div className="grid gap-3 lg:col-span-2 lg:grid-cols-2">
            <Panel title="Markup tools">
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-1.5">
                  {TOOL_OPTIONS.map((option) => (
                    <button
                      autoComplete="off"
                      key={option.value}
                      type="button"
                      onClick={() => setTool(option.value)}
                      className={`rounded-lg border px-2.5 py-2 text-left text-xs ${tool === option.value ? "border-accent bg-accent/10 text-accent-soft" : "border-line bg-surface text-muted hover:text-ink"}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                <Field label="Mark color">
                  <Select value={color} onChange={(event) => setColor(event.target.value)}>
                    {COLOR_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </Select>
                </Field>
                {tool === "text" ? (
                  <>
                    <Field label="Text">
                      <TextInput value={text} onChange={(event) => setText(event.target.value)} maxLength={500} />
                    </Field>
                    <Field label="Font size">
                      <NumberField min={8} max={96} fallback={18} value={textSize} onValueChange={setTextSize} />
                    </Field>
                    <Notice>Standard PDF font supports common Western characters; unusual glyphs may not export.</Notice>
                    {selectedMarkData?.type === "text" ? (
                      <Button variant="primary" disabled={busy} onClick={updateSelectedText}>Update selected text</Button>
                    ) : null}
                  </>
                ) : null}
                {tool === "image" ? (
                  <>
                    <input ref={imageInput} type="file" accept="image/png,image/jpeg" className="hidden" onChange={(event) => void chooseImage(event.target.files?.[0])} />
                    <Button onClick={() => imageInput.current?.click()}>{imageData ? "Choose another image" : "Choose PNG / JPEG"}</Button>
                    <Notice>Choose an image, then click the page to place it.</Notice>
                  </>
                ) : null}
                {tool === "draw" ? <Notice>Drag on the page to draw or sign. Touch input is supported.</Notice> : null}
                {tool === "select" ? <Notice>Click a mark to select it. Drag to move; choose Text to edit its content and size, then update it.</Notice> : null}
              </div>
            </Panel>

            <Panel title="OCR text · browser">
              <div className="space-y-3">
                <Notice>Extracts text in this browser with bundled Tesseract WASM and English/Polish language data. No upload; this does not add a searchable layer to the PDF. Use Searchable PDF (server) above for that.</Notice>
                <Field label="Language">
                  <Select value={language} disabled={busy} onChange={(event) => setLanguage(event.target.value as OcrLanguage)}>
                    <option value="eng">English</option>
                    <option value="pol">Polish</option>
                    <option value="eng+pol">English + Polish</option>
                  </Select>
                </Field>
                {ocrProgress ? (
                  <div className="space-y-2">
                    <progress className="w-full accent-accent" value={ocrProgress.value} max={1} aria-label="OCR progress" />
                    <p role="status" className="text-xs text-muted">{ocrProgress.label} · {Math.round(ocrProgress.value * 100)}%</p>
                    <Button onClick={() => { cancelOcr.current = true; }}>Stop after this page</Button>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    <Button disabled={!activePage || busy} onClick={() => void runOcr(false)}>Current page</Button>
                    <Button disabled={!availablePages.length || busy} onClick={() => void runOcr(true)}>All pages</Button>
                  </div>
                )}
                {ocrDone && !ocrProgress ? <p role="status" className="text-xs text-good">{ocrDone}</p> : null}
                {ocrText ? (
                  <>
                    <TextArea readOnly rows={10} value={ocrText} />
                    <Button onClick={() => downloadBlob(new Blob([ocrText], { type: "text/plain;charset=utf-8" }), currentOcrName)}>Download OCR text</Button>
                  </>
                ) : null}
                <p className="text-[11px] leading-relaxed text-faint">First use loads the local worker and selected language data from this app. Large scans can take time; higher-resolution originals usually improve recognition.</p>
              </div>
            </Panel>
          </div>
        </div>
      )}
    </div>
  );
}

function hexRgb(hex: string): [number, number, number] {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16) / 255) as [number, number, number];
}

function dataUrlBytes(value: string): Uint8Array {
  const encoded = value.slice(value.indexOf(",") + 1);
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function safeStem(name: string): string {
  return name.replace(/\.(pdf|png|jpe?g|webp|gif|bmp|avif)$/i, "").replace(/[^\w.-]+/g, "_") || "document";
}

/** Snapshot the editor's current page order, rotations and marks for either export path. */
async function serializeEditedPdf(file: File, pages: readonly EditorPage[]): Promise<Blob> {
  const source = await PDFDocument.load(await file.arrayBuffer());
  const output = await PDFDocument.create();
  const font = await output.embedFont(StandardFonts.Helvetica);
  for (const state of pages) {
    const [copiedPage] = await output.copyPages(source, [state.originalIndex]);
    const page = output.addPage(copiedPage);
    page.setRotation(degrees((page.getRotation().angle + state.rotation + 360) % 360));
    const size = page.getSize();
    for (const mark of state.marks) {
      if (mark.type === "text") {
        page.drawText(mark.text ?? "Text", {
          x: mark.x,
          y: mark.y,
          size: mark.size ?? 18,
          font,
          color: rgb(...hexRgb(mark.color)),
        });
      } else if (mark.type === "highlight" || mark.type === "rectangle" || mark.type === "image") {
        const x = Math.min(mark.x, mark.x2 ?? mark.x);
        const y = Math.min(mark.y, mark.y2 ?? mark.y);
        const width = Math.abs((mark.x2 ?? mark.x) - mark.x);
        const height = Math.abs((mark.y2 ?? mark.y) - mark.y);
        if (mark.type === "image" && mark.imageData) {
          const imageBytes = dataUrlBytes(mark.imageData);
          const image = mark.imageData.startsWith("data:image/png")
            ? await output.embedPng(imageBytes)
            : await output.embedJpg(imageBytes);
          const imageWidth = Math.max(8, width);
          const imageHeight = Math.max(8, height);
          page.drawImage(image, { x, y, width: imageWidth, height: imageHeight });
        } else {
          page.drawRectangle({
            x,
            y,
            width: Math.max(2, width),
            height: Math.max(2, height),
            color: mark.type === "highlight" ? rgb(...hexRgb(mark.color)) : undefined,
            opacity: mark.type === "highlight" ? 0.32 : 0,
            borderColor: rgb(...hexRgb(mark.color)),
            borderWidth: mark.type === "rectangle" ? 2 : 0,
          });
        }
      } else if (mark.type === "draw" && mark.points && mark.points.length > 1) {
        for (let index = 1; index < mark.points.length; index += 1) {
          const start = mark.points[index - 1];
          const end = mark.points[index];
          page.drawLine({ start, end, thickness: 2.5, color: rgb(...hexRgb(mark.color)) });
        }
      }
    }
    if (size.width <= 0 || size.height <= 0) throw new Error(`Page ${state.originalIndex + 1} has invalid dimensions.`);
  }
  const bytes = await output.save();
  return new Blob([new Uint8Array(bytes)], { type: "application/pdf" });
}

/**
 * OCRmyPDF preserves pages that already have text. Flatten only marked pages so
 * a text overlay cannot suppress OCR of the scan beneath it, and image marks
 * are recognized too. Untouched digital pages retain their original text.
 */
async function serializeSearchablePdf(file: File, pages: readonly EditorPage[], cancelled: () => boolean): Promise<Blob> {
  const edited = await serializeEditedPdf(file, pages);
  if (!pages.some((page) => page.marks.length)) return edited;
  const checkCancelled = () => {
    if (cancelled()) throw new DOMException("Searchable PDF cancelled.", "AbortError");
  };
  checkCancelled();
  const bytes = new Uint8Array(await edited.arrayBuffer());
  const source = await PDFDocument.load(bytes);
  const output = await PDFDocument.create();
  const pdfjs = await import("pdfjs-dist");
  const loading = pdfjs.getDocument({ data: bytes.slice() });
  const rendered = await loading.promise;
  try {
    for (const [index, state] of pages.entries()) {
      checkCancelled();
      if (!state.marks.length) {
        const [page] = await output.copyPages(source, [index]);
        output.addPage(page);
        continue;
      }
      const page = await rendered.getPage(index + 1);
      const size = page.getViewport({ scale: 1 });
      // At most 300 dpi / 16 megapixels per marked page; release each canvas
      // before moving to the next so a long document cannot retain all rasters.
      const scale = Math.min(300 / 72, Math.sqrt(16_000_000 / (size.width * size.height)));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Canvas 2D is unavailable for searchable PDF export.");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        checkCancelled();
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error("Could not prepare a marked PDF page.")), "image/png",
        ));
        const image = await output.embedPng(await png.arrayBuffer());
        const flattened = output.addPage([size.width, size.height]);
        flattened.drawImage(image, { x: 0, y: 0, width: size.width, height: size.height });
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    checkCancelled();
    return new Blob([new Uint8Array(await output.save())], { type: "application/pdf" });
  } finally {
    await loading.destroy();
  }
}
