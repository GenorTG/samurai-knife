"use client";

import { useEffect, useRef, useState, type PointerEvent } from "react";
import { Button, Dropzone, Field, Notice, Panel } from "@/components/ui";
import { errorText } from "@/lib/cv/client";
import { cropRect, decodePicture, DEFAULT_CROP, drawCrop, encodePhoto, type Crop, type Picture } from "./photo-crop";
import { useCvPhoto } from "./usePhoto";
import { useT } from "@/lib/i18n/react";

const PREVIEW = 224;

function Slider({ label, value, min, max, step, onChange }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <Field label={label}>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} className="w-full accent-[var(--color-accent)]" />
    </Field>
  );
}

/** Crop editor: live square preview with a round guide, drag to move, sliders for keyboard users. */
function CropEditor({ picture, name, onSave, onCancel }: { picture: Picture; name: string; onSave: (dataUrl: string) => Promise<void>; onCancel: () => void }) {
  const { t } = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ x: number; y: number; crop: Crop } | null>(null);
  const [crop, setCrop] = useState<Crop>(DEFAULT_CROP);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (canvas.current) drawCrop(canvas.current, picture, crop, PREVIEW * 2);
  }, [picture, crop]);

  const onPointerDown = (e: PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, crop };
  };
  const onPointerMove = (e: PointerEvent<HTMLCanvasElement>) => {
    const start = drag.current;
    if (!start) return;
    // Moving the picture right shows more of its left side: the crop centre moves the other way.
    const { side } = cropRect(picture, start.crop);
    const perPx = side / PREVIEW;
    setCrop({
      ...start.crop,
      cx: Math.min(Math.max(start.crop.cx - ((e.clientX - start.x) * perPx) / picture.width, 0), 1),
      cy: Math.min(Math.max(start.crop.cy - ((e.clientY - start.y) * perPx) / picture.height, 0), 1),
    });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  // Pin the centre inside the reachable range so the sliders never sit on a dead zone.
  const { sx, sy, side } = cropRect(picture, crop);
  const shown = { cx: (sx + side / 2) / picture.width, cy: (sy + side / 2) / picture.height };

  const save = async () => {
    setBusy(true);
    setError("");
    try {
      await onSave(encodePhoto(picture, crop));
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3" data-agent-region="cv-photo-crop">
      <p className="text-xs text-muted wrap-anywhere">{t("Framing {name}: drag the picture or use the sliders. Only this square crop is uploaded.", { name })}</p>
      <div className="relative mx-auto w-fit">
        <canvas
          ref={canvas}
          aria-label={t("Photo crop preview")}
          role="img"
          style={{ width: PREVIEW, height: PREVIEW, touchAction: "none" }}
          className="block cursor-grab rounded-lg border border-line active:cursor-grabbing"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        />
        <span aria-hidden className="pointer-events-none absolute inset-0 rounded-full border-2 border-dashed border-white/80 shadow-[0_0_0_1px_rgb(0_0_0/0.25)]" />
      </div>
      <Slider label={t("Zoom")} value={crop.zoom} min={1} max={4} step={0.01} onChange={(zoom) => setCrop({ ...crop, ...shown, zoom })} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Slider label={t("Left / right")} value={shown.cx} min={0} max={1} step={0.005} onChange={(cx) => setCrop({ ...crop, cx })} />
        <Slider label={t("Up / down")} value={shown.cy} min={0} max={1} step={0.005} onChange={(cy) => setCrop({ ...crop, cy })} />
      </div>
      {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>{busy ? t("Saving…") : t("Save photo")}</Button>
        <Button onClick={onCancel} disabled={busy}>{t("Cancel")}</Button>
      </div>
    </div>
  );
}

/** Profile tab: the account's CV photo (upload, crop, replace, remove). Layouts decide where it prints. */
export function PhotoPanel() {
  const { t } = useT();
  const photo = useCvPhoto();
  const [picked, setPicked] = useState<{ picture: Picture; name: string } | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const pick = async (files: File[]) => {
    setError("");
    const file = files[0];
    if (!file) return;
    try {
      setPicked({ picture: await decodePicture(file), name: file.name });
    } catch (e) {
      setError(errorText(e));
    }
  };

  const showDropzone = !picked && (!photo.meta || replacing);

  return (
    <Panel title={t("Photo")}>
      <div className="space-y-3" data-cv-path="/photo">
        <p className="text-xs leading-relaxed text-muted">
          {t("Printed by the Modern, Sidebar and Elegant layouts (CV versions tab, switch it off per document there). The ATS layout never prints a photo.")}
        </p>
        {photo.phase === "error" ? <Notice tone="error">{t("Could not load the photo:")}{" "} {photo.error}</Notice> : null}
        {photo.meta && !picked ? (
          <div className="flex flex-wrap items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element -- private, authenticated image; next/image would proxy it */}
            <img src={photo.url ?? ""} alt={t("Your CV photo")} width={112} height={112} className="size-28 rounded-full border border-line object-cover" />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setReplacing((v) => !v)} aria-expanded={replacing}>{replacing ? t("Keep this photo") : t("Change photo…")}</Button>
              <Button
                size="sm"
                variant="danger"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError("");
                  try {
                    await photo.remove();
                    setReplacing(false);
                  } catch (e) {
                    setError(errorText(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t("Remove photo")}
              </Button>
            </div>
          </div>
        ) : null}
        {showDropzone ? <Dropzone accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/bmp" hint={t("JPEG, PNG or WebP · cropped in your browser")} onFiles={(files) => void pick(files)} /> : null}
        {picked ? (
          <CropEditor
            key={picked.name}
            picture={picked.picture}
            name={picked.name}
            onCancel={() => setPicked(null)}
            onSave={async (dataUrl) => {
              await photo.upload(dataUrl);
              setPicked(null);
              setReplacing(false);
            }}
          />
        ) : null}
        {error ? <div role="alert"><Notice tone="error">{error}</Notice></div> : null}
      </div>
    </Panel>
  );
}
