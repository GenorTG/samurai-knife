/**
 * Folds `docker compose --progress json pull` events (one JSON object per stderr line) into one progress figure.
 * Layer events carry `parent_id` (the service) and, while downloading/extracting, `current`/`total` bytes. Pure.
 */

export interface PullProgress {
  layers: number;
  layersDone: number;
  downloadedBytes: number;
  /** Sum of the sizes of the layers whose size is known so far (it grows as layers start). */
  totalBytes: number;
  /** 0-100 across download (80%) and extraction (20%). */
  percent: number;
  phase: "waiting" | "downloading" | "extracting" | "done";
}

interface LayerState {
  size: number;
  downloaded: number;
  extracted: number;
  done: boolean;
}

export class PullTracker {
  private readonly layers = new Map<string, LayerState>();
  private finished = false;

  /** Returns true when the line was a progress event. */
  feed(line: string): boolean {
    let event: { id?: unknown; parent_id?: unknown; text?: unknown; current?: unknown; total?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return false;
    }
    if (typeof event.id !== "string" || typeof event.text !== "string") return false;
    const text = event.text;
    if (typeof event.parent_id !== "string") {
      if (/^Pulled$|^Skipped/.test(text)) this.finished = true;
      return true;
    }
    const layer = this.layers.get(event.id) ?? { size: 0, downloaded: 0, extracted: 0, done: false };
    this.layers.set(event.id, layer);
    const current = typeof event.current === "number" ? event.current : null;
    const total = typeof event.total === "number" && event.total > 0 ? event.total : null;
    if (text === "Downloading") {
      if (total) layer.size = total;
      if (current !== null) layer.downloaded = current;
    } else if (text === "Download complete" || text === "Verifying Checksum") {
      layer.downloaded = layer.size;
    } else if (text === "Extracting") {
      if (total) layer.size = layer.size || total;
      layer.downloaded = layer.size;
      if (current !== null) layer.extracted = current;
    } else if (text === "Pull complete" || text === "Already exists") {
      layer.downloaded = layer.size;
      layer.extracted = layer.size;
      layer.done = true;
    }
    return true;
  }

  snapshot(): PullProgress {
    let total = 0;
    let downloaded = 0;
    let extracted = 0;
    let done = 0;
    for (const layer of this.layers.values()) {
      total += layer.size;
      downloaded += Math.min(layer.downloaded, layer.size);
      extracted += Math.min(layer.extracted, layer.size);
      if (layer.done) done += 1;
    }
    const layers = this.layers.size;
    const allDone = this.finished || (layers > 0 && done === layers);
    const percent = allDone ? 100 : total > 0 ? Math.min(99, Math.floor(((downloaded / total) * 0.8 + (extracted / total) * 0.2) * 100)) : 0;
    const phase: PullProgress["phase"] = allDone ? "done" : extracted > 0 ? "extracting" : downloaded > 0 ? "downloading" : "waiting";
    return { layers, layersDone: done, downloadedBytes: downloaded, totalBytes: total, percent, phase };
  }
}
