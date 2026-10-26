"use client";

import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { Badge, Button, Dropzone, EmptyState, Field, Notice, Panel, SegmentedControl, Select, StorageMeter, TextInput } from "@/components/ui";
import { formatBytes } from "@/lib/format";
import { OFFICE_FORMATS } from "@/lib/office/templates";
import {
  createDoc,
  createFolder,
  deleteDocForever,
  deleteFolderForever,
  docAction,
  docDownloadUrl,
  emptyTrash,
  errorText,
  fileToBase64,
  folderAction,
  getLibrary,
  isQuotaFull,
  renameDoc,
  uploadDoc,
  type DocMeta,
  type Folder,
  type OfficeFormat,
  type OfficeLibrary,
} from "./client";
import { DocEditor } from "./OfficeEditor";
import { VersionsPanel, when } from "./OfficeVersions";
import { SidecarCard } from "./SidecarCard";
import { useSidecar } from "./useSidecar";
import { useT } from "@/lib/i18n/react";
import { msg } from "@/lib/i18n/msg";

const SERVICE = "office";
const FORMAT_LABEL: Record<OfficeFormat, string> = {
  docx: msg("Word document (.docx)"),
  xlsx: msg("Excel spreadsheet (.xlsx)"),
  pptx: msg("PowerPoint presentation (.pptx)"),
  odt: msg("OpenDocument text (.odt)"),
  ods: msg("OpenDocument spreadsheet (.ods)"),
  odp: msg("OpenDocument presentation (.odp)"),
};
const ACCEPT = OFFICE_FORMATS.map((f) => `.${f}`).join(",");

type SortKey = "name" | "updated" | "size" | "type";
type Sort = { key: SortKey; dir: "asc" | "desc" };
type Note = { tone: "good" | "error" | "info"; text: string; undo?: () => Promise<void> } | null;
type Expanded = { id: string; panel: "actions" | "versions" } | null;

const linkButton = "inline-flex h-7 items-center rounded-lg border border-line-strong px-2.5 text-xs text-ink hover:bg-raised";

/** "Work / Offers" for a folder id; "" for the root. */
function pathOf(folders: Folder[], id: string | null): string {
  const parts: string[] = [];
  for (let at = id, guard = 0; at && guard < 32; guard += 1) {
    const f = folders.find((x) => x.id === at);
    if (!f) break;
    parts.unshift(f.name);
    at = f.parentId;
  }
  return parts.join(" / ");
}

function chain(folders: Folder[], id: string | null): Folder[] {
  const out: Folder[] = [];
  for (let at = id, guard = 0; at && guard < 32; guard += 1) {
    const f = folders.find((x) => x.id === at);
    if (!f) break;
    out.unshift(f);
    at = f.parentId;
  }
  return out;
}

function below(folders: Folder[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of folders) if (f.parentId && out.has(f.parentId) && !out.has(f.id)) {
      out.add(f.id);
      grew = true;
    }
  }
  return out;
}

function compareDocs(sort: Sort) {
  return (a: DocMeta, b: DocMeta): number => {
    const sign = sort.dir === "asc" ? 1 : -1;
    const by =
      sort.key === "name" ? a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true })
        : sort.key === "updated" ? a.updatedAt.localeCompare(b.updatedAt)
          : sort.key === "size" ? a.bytes - b.bytes
            : a.format.localeCompare(b.format) || a.name.localeCompare(b.name, "en", { sensitivity: "base" });
    return by * sign;
  };
}

function setQuery(params: Record<string, string | null>): void {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  window.history.replaceState(window.history.state, "", url);
}

/** Folder targets for a Move select: the root plus every live folder (minus `exclude`), by path. */
function FolderSelect({ folders, value, onChange, exclude, label }: { folders: Folder[]; value: string; onChange: (v: string) => void; exclude?: Set<string>; label: string }) {
  const { t } = useT();
  const options = folders.filter((f) => !exclude?.has(f.id)).map((f) => ({ id: f.id, path: pathOf(folders, f.id) })).sort((a, b) => a.path.localeCompare(b.path, "en", { sensitivity: "base" }));
  return (
    <Select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="min-w-48">
      <option value="">{t("Library (top level)")}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>{o.path}</option>
      ))}
    </Select>
  );
}

function SortHeader({ label, sortKey, sort, onSort }: { label: string; sortKey: SortKey; sort: Sort; onSort: (s: Sort) => void }) {
  const active = sort.key === sortKey;
  return (
    <th className="px-3 py-2 font-medium" aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
      <button
        type="button"
        autoComplete="off"
        className="inline-flex items-center gap-1 rounded hover:text-ink"
        onClick={() => onSort({ key: sortKey, dir: active && sort.dir === "asc" ? "desc" : active ? "asc" : sortKey === "name" || sortKey === "type" ? "asc" : "desc" })}
      >
        {label}
        <span aria-hidden="true">{active ? (sort.dir === "asc" ? "▲" : "▼") : ""}</span>
        <span className="sr-only">{active ? "" : `, sort by ${label.toLowerCase()}`}</span>
      </button>
    </th>
  );
}

/** One expanded row under a document or folder: Escape closes it. */
function DetailRow({ colSpan, onClose, children }: { colSpan: number; onClose: () => void; children: ReactNode }) {
  return (
    <tr
      className="bg-raised/40"
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <td colSpan={colSpan} className="px-3 py-3">{children}</td>
    </tr>
  );
}

function RenameForm({ initial, label, onSave }: { initial: string; label: string; onSave: (name: string) => Promise<void> }) {
  const { t } = useT();
  const [value, setValue] = useState(initial);
  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (value.trim()) void onSave(value.trim());
      }}
    >
      <Field label={t("Rename to")} className="min-w-56 flex-1">
        <TextInput autoFocus aria-label={label} value={value} onChange={(e) => setValue(e.target.value)} maxLength={120} />
      </Field>
      <Button type="submit" size="sm" variant="primary" disabled={!value.trim() || value.trim() === initial}>{t("Rename")}</Button>
    </form>
  );
}

function MoveForm({ folders, current, exclude, label, onMove }: { folders: Folder[]; current: string | null; exclude?: Set<string>; label: string; onMove: (to: string | null) => Promise<void> }) {
  const { t } = useT();
  const [target, setTarget] = useState(current ?? "");
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t("Move to")}>
        <FolderSelect folders={folders} value={target} onChange={setTarget} exclude={exclude} label={label} />
      </Field>
      <Button size="sm" disabled={(target || null) === current} onClick={() => void onMove(target || null)}>{t("Move")}</Button>
    </div>
  );
}

/** Office documents: the per-account file browser + the Euro-Office editor (sidecar). Everything but editing works without the sidecar. */
export default function OfficeTool() {
  const { t, tn } = useT();
  const sidecar = useSidecar(SERVICE);
  const [lib, setLib] = useState<OfficeLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [note, setNote] = useState<Note>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [format, setFormat] = useState<OfficeFormat>("docx");
  const [name, setName] = useState("");
  const [view, setView] = useState<"files" | "trash">("files");
  const [query, setQueryText] = useState("");
  const [sort, setSort] = useState<Sort>({ key: "updated", dir: "desc" });
  const [expanded, setExpanded] = useState<Expanded>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  // Browser-only component (ssr: false in registry-client), so the URL can seed the state directly.
  const initial = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
  const [openId, setOpenId] = useState<string | null>(() => initial?.get("doc") ?? null);
  const [folderId, setFolderId] = useState<string | null>(() => initial?.get("folder") ?? null);

  const reload = useCallback((): Promise<void> => {
    return getLibrary().then(
      (next) => {
        setLib(next);
        setLoadError(null);
      },
      (err) => setLoadError(errorText(err)),
    );
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Changes made elsewhere (another tab, the assistant, an MCP client) show up without a reload.
  useEffect(() => {
    if (openId) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void reload();
    }, 10_000);
    return () => clearInterval(timer);
  }, [openId, reload]);

  const say = useCallback((tone: "good" | "error" | "info", text: string, undo?: () => Promise<void>) => setNote({ tone, text, undo }), []);
  // A full quota (507) carries its own readable message ("Not enough storage: … Free space by …").
  const fail = useCallback((err: unknown) => say("error", isQuotaFull(err) ? errorText(err) : t("Could not finish: {err}", { err: errorText(err) })), [t, say]);

  /** Runs one change with a role=status line, then reloads; errors become the notice. */
  const act = useCallback(async (label: string, fn: () => Promise<string | void>, undo?: () => Promise<void>) => {
    setProgress(`${label}…`);
    try {
      const message = await fn();
      if (message) say("good", message, undo);
      setExpanded(null);
      await reload();
    } catch (err) {
      fail(err);
    } finally {
      setProgress(null);
    }
  }, [fail, reload, say]);

  const open = (id: string | null) => {
    setOpenId(id);
    setQuery({ doc: id });
    if (!id) void reload();
  };
  const enter = (id: string | null) => {
    setFolderId(id);
    setExpanded(null);
    setQueryText("");
    setQuery({ folder: id });
  };

  const folders = useMemo(() => lib?.folders ?? [], [lib]);
  const currentFolder = folderId ? folders.find((f) => f.id === folderId) ?? null : null;
  // A folder that went away (trashed elsewhere) falls back to the root.
  const cwd = currentFolder ? currentFolder.id : null;
  const free = lib && lib.storage.quotaBytes !== null ? Math.max(0, lib.storage.quotaBytes - lib.storage.usedBytes) : Number.POSITIVE_INFINITY;

  const q = query.trim().toLowerCase();
  // Plain computations (the React Compiler memoizes them): manual useMemo here could not be preserved once t() calls
  // took values from these lists.
  const folderList = q ? folders.filter((f) => f.name.toLowerCase().includes(q)) : folders.filter((f) => f.parentId === cwd);
  const visibleFolders = [...folderList].sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base", numeric: true }) * (sort.key === "name" && sort.dir === "desc" ? -1 : 1));
  const allDocs = lib?.docs ?? [];
  const docList = q ? allDocs.filter((d) => d.name.toLowerCase().includes(q)) : allDocs.filter((d) => (d.folderId ?? null) === cwd);
  const visibleDocs = [...docList].sort(compareDocs(sort));

  const service = sidecar.service;
  const openDoc = openId ? lib?.docs.find((d) => d.id === openId) : undefined;

  if (openId && openDoc) {
    return <DocEditor key={openDoc.id} doc={openDoc} sidecar={sidecar} onClose={() => open(null)} />;
  }

  const where = currentFolder ? currentFolder.name : "the library";
  const upload = async (files: File[]) => {
    const total = files.length;
    const done: string[] = [];
    let room = free;
    try {
      for (const [index, file] of files.entries()) {
        if (file.size > room) {
          throw new Error(`${file.name} (${formatBytes(file.size)}) does not fit: ${formatBytes(Math.max(0, room))} of your storage is free. Empty the trash or prune old versions to make room.`);
        }
        setProgress(t("Uploading {value} of {total}: {name} ({file})…", { value: index + 1, total, name: file.name, file: formatBytes(file.size) }));
        await uploadDoc(file.name, await fileToBase64(file), cwd);
        room -= file.size;
        done.push(file.name);
      }
      say("good", t("Uploaded {join} into {where}.", { join: done.join(", "), where }));
    } catch (err) {
      say("error", `${done.length ? t("Uploaded {join}; then: ", { join: done.join(", ") }) : ""}${errorText(err)}`);
    } finally {
      setProgress(null);
      await reload();
    }
  };

  const toggle = (id: string, panel: "actions" | "versions") => setExpanded((cur) => (cur?.id === id && cur.panel === panel ? null : { id, panel }));
  const searching = q.length > 0;
  const columns = searching ? 7 : 6;
  const trashCount = (lib?.trash.docs.length ?? 0) + (lib?.trash.folders.length ?? 0);

  return (
    <div className="space-y-5">
      {service && !service.installed ? (
        <SidecarCard
          sidecar={sidecar}
          compact
          intro={
            <Notice tone="info">
              {t("Editing in the browser needs the office editor service, which is not installed yet. Your library below works without it: upload, create, download, folders, versions and the trash.")}
            </Notice>
          }
        />
      ) : null}
      {openId && lib && !openDoc ? <Notice tone="warn">{t("That document no longer exists (or is in the trash).")}</Notice> : null}
      {loadError ? <Notice tone="error">{loadError}</Notice> : null}
      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title={t("New document")}>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault();
              void act(t("Creating the document"), async () => {
                const doc = await createDoc(format, name.trim() || "Untitled", cwd);
                setName("");
                return t("Created {name} in {where}.", { name: doc.name, where });
              });
            }}
          >
            <Field label={t("Type")}>
              <Select value={format} onChange={(e) => setFormat(e.target.value as OfficeFormat)}>
                {OFFICE_FORMATS.map((f) => (
                  <option key={f} value={f}>{t(FORMAT_LABEL[f])}</option>
                ))}
              </Select>
            </Field>
            <Field label={t("Name")}>
              <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder={t("Untitled")} maxLength={120} />
            </Field>
            <Button type="submit" variant="primary" disabled={progress !== null}>{t("Create")}</Button>
          </form>
        </Panel>
        <Panel title={t("Upload")}>
          <Dropzone
            accept={ACCEPT}
            multiple
            disabled={progress !== null}
            hint={t("docx, xlsx, pptx, odt, ods, odp · up to 50 MB each · into {where}", { where })}
            onFiles={(files) => void upload(files)}
          />
        </Panel>
      </div>

      <Panel
        title={t("Your documents")}
        right={lib ? <StorageMeter compact usedBytes={lib.storage.usedBytes} quotaBytes={lib.storage.quotaBytes} label={t("Your storage")} /> : null}
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              label={t("Show")}
              value={view}
              onChange={(next) => {
                setView(next);
                setExpanded(null);
                setConfirm(null);
              }}
              options={[
                { value: "files", label: "Files" },
                { value: "trash", label: `Trash${trashCount ? ` (${trashCount})` : ""}` },
              ]}
            />
            {view === "files" ? (
              <>
                <TextInput
                  type="search"
                  aria-label={t("Search documents")}
                  placeholder={t("Search all folders")}
                  value={query}
                  onChange={(e) => setQueryText(e.target.value)}
                  className="w-56 max-w-full"
                />
                <Button size="sm" onClick={() => setNewFolder((v) => (v === null ? "" : null))} aria-expanded={newFolder !== null}>{t("New folder")}</Button>
              </>
            ) : null}
          </div>

          {view === "files" && newFolder !== null ? (
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const clean = newFolder.trim();
                if (!clean) return;
                void act(t("Creating the folder"), async () => {
                  const folder = await createFolder(clean, cwd);
                  setNewFolder(null);
                  return t("Created folder {name} in {where}.", { name: folder.name, where });
                });
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") setNewFolder(null);
              }}
            >
              <Field label={t("Folder name")} className="min-w-56 flex-1">
                <TextInput autoFocus value={newFolder} onChange={(e) => setNewFolder(e.target.value)} maxLength={120} />
              </Field>
              <Button type="submit" size="sm" variant="primary" disabled={!newFolder.trim()}>{t("Create folder")}</Button>
              <Button size="sm" variant="ghost" onClick={() => setNewFolder(null)}>{t("Cancel")}</Button>
            </form>
          ) : null}

          <div role="status" aria-live="polite" data-agent-region="office-library-status" className="min-h-5 text-sm text-muted">
            {progress ?? (lib === null && !loadError ? t("Loading documents…") : "")}
          </div>
          {note ? (
            <div className="flex flex-wrap items-center gap-2">
              <div className="min-w-0 flex-1"><Notice tone={note.tone}>{note.text}</Notice></div>
              {note.undo ? (
                <Button size="sm" onClick={() => {
                  const undo = note.undo;
                  setNote(null);
                  if (undo) void act("Undoing", async () => {
                    await undo();
                    return "Restored.";
                  });
                }}>{t("Undo")}</Button>
              ) : null}
              <Button size="sm" variant="ghost" aria-label={t("Dismiss message")} onClick={() => setNote(null)}>{t("Dismiss")}</Button>
            </div>
          ) : null}

          {view === "files" ? (
            <>
              <nav aria-label={t("Folder path")} className="flex flex-wrap items-center gap-1 text-sm">
                {searching ? (
                  <span className="text-muted">{t("Search results in every folder for “{value}”", { value: query.trim() })}</span>
                ) : (
                  <>
                    <button type="button" autoComplete="off" className="rounded px-1 text-accent-soft hover:underline" onClick={() => enter(null)} aria-current={cwd === null ? "page" : undefined}>
                      {t("Library")}
                    </button>
                    {chain(folders, cwd).map((f) => (
                      <span key={f.id} className="flex items-center gap-1">
                        <span aria-hidden="true" className="text-faint">/</span>
                        <button type="button" autoComplete="off" className="rounded px-1 text-accent-soft hover:underline" onClick={() => enter(f.id)} aria-current={f.id === cwd ? "page" : undefined}>
                          {f.name}
                        </button>
                      </span>
                    ))}
                  </>
                )}
              </nav>
              {lib === null ? null : visibleFolders.length === 0 && visibleDocs.length === 0 ? (
                <EmptyState title={searching ? t("Nothing matches") : cwd ? t("This folder is empty") : t("No documents yet")}>
                  {searching ? t("Try another name.") : t("Create a blank document, upload one, or make a folder.")}
                </EmptyState>
              ) : (
                <div className="-mx-4 overflow-x-auto sm:-mx-5">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left text-xs text-faint">
                        <SortHeader label={t("Name")} sortKey="name" sort={sort} onSort={setSort} />
                        {searching ? <th className="px-3 py-2 font-medium">{t("Folder")}</th> : null}
                        <SortHeader label={t("Type")} sortKey="type" sort={sort} onSort={setSort} />
                        <SortHeader label={t("Size")} sortKey="size" sort={sort} onSort={setSort} />
                        <SortHeader label={t("Updated (UTC)")} sortKey="updated" sort={sort} onSort={setSort} />
                        <th className="px-3 py-2 font-medium">{t("Version")}</th>
                        <th className="px-3 py-2"><span className="sr-only">{t("Actions")}</span></th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleFolders.map((folder) => {
                        const isOpen = expanded?.id === folder.id;
                        const count = (lib.docs.filter((d) => d.folderId === folder.id).length) + folders.filter((f) => f.parentId === folder.id).length;
                        return [
                          <tr key={folder.id} className="border-t border-line align-middle">
                            <td className="px-3 py-2">
                              <button type="button" autoComplete="off" className="text-left font-medium text-ink hover:text-accent-soft hover:underline" onClick={() => enter(folder.id)} aria-label={t("Open folder {name}", { name: folder.name })}>
                                <span aria-hidden="true" className="mr-1.5 text-faint">▸</span>{folder.name}
                              </button>
                            </td>
                            {searching ? <td className="px-3 py-2 text-xs text-muted">{pathOf(folders, folder.parentId) || t("Library")}</td> : null}
                            <td className="px-3 py-2"><Badge>{t("folder")}</Badge></td>
                            <td className="px-3 py-2 font-mono text-xs text-muted">{tn("{n} item", "{n} items", count)}</td>
                            <td className="px-3 py-2 font-mono text-xs text-muted">{when(folder.updatedAt)}</td>
                            <td className="px-3 py-2" />
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button size="sm" variant="ghost" aria-expanded={isOpen} aria-label={t("More actions for folder {name}", { name: folder.name })} onClick={() => toggle(folder.id, "actions")}>{t("Actions")}</Button>
                                <Button size="sm" variant="danger" aria-label={t("Move folder {name} to the trash", { name: folder.name })} onClick={() => void act(t("Moving {name} to the trash", { name: folder.name }), async () => {
                                  const r = await folderAction(folder.id, { action: "trash" });
                                  return t("Moved folder {name}{value} to the trash.", { name: folder.name, value: r.docs ? ` and ${r.docs} document(s) in it` : "" });
                                }, async () => {
                                  await folderAction(folder.id, { action: "restore" });
                                })}>{t("Trash")}</Button>
                              </div>
                            </td>
                          </tr>,
                          isOpen ? (
                            <DetailRow key={`${folder.id}-x`} colSpan={columns} onClose={() => setExpanded(null)}>
                              <div className="flex flex-wrap items-end gap-6">
                                <RenameForm initial={folder.name} label={t("New name for folder {name}", { name: folder.name })} onSave={(next) => act("Renaming", async () => {
                                  await folderAction(folder.id, { action: "rename", name: next });
                                  return t("Renamed folder to {next}.", { next });
                                })} />
                                <MoveForm folders={folders} current={folder.parentId} exclude={below(folders, folder.id)} label={t("Destination for folder {name}", { name: folder.name })} onMove={(to) => act("Moving", async () => {
                                  await folderAction(folder.id, { action: "move", parentId: to });
                                  return t("Moved folder {name} to {value}.", { name: folder.name, value: pathOf(folders, to) || "the library" });
                                })} />
                              </div>
                            </DetailRow>
                          ) : null,
                        ];
                      })}
                      {visibleDocs.map((doc) => {
                        const panel = expanded?.id === doc.id ? expanded.panel : null;
                        return [
                          <tr key={doc.id} className="border-t border-line align-middle">
                            <td className="px-3 py-2">
                              <button type="button" autoComplete="off" className="text-left font-medium text-ink hover:text-accent-soft hover:underline" onClick={() => open(doc.id)} title={t("Open in the editor")}>
                                {doc.name}
                              </button>
                              {doc.lastSaveError ? <span className="block text-xs text-danger">{t("Last editor save refused:")}{" "} {doc.lastSaveError.message}</span> : null}
                            </td>
                            {searching ? <td className="px-3 py-2 text-xs text-muted">{pathOf(folders, doc.folderId) || t("Library")}</td> : null}
                            <td className="px-3 py-2"><Badge>{doc.format}</Badge></td>
                            <td className="px-3 py-2 font-mono text-xs text-muted">{formatBytes(doc.bytes)}</td>
                            <td className="px-3 py-2 font-mono text-xs text-muted">{when(doc.updatedAt)}</td>
                            <td className="px-3 py-2 font-mono text-xs text-muted">v{doc.version}{doc.versions?.length ? ` · ${doc.versions.length} kept` : ""}</td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap justify-end gap-2">
                                <Button size="sm" variant="primary" onClick={() => open(doc.id)} aria-label={t("Open {name}", { name: doc.name })}>{t("Open")}</Button>
                                <a className={linkButton} href={docDownloadUrl(doc.id)} download={doc.name} aria-label={t("Download {name}", { name: doc.name })}>{t("Download")}</a>
                                <Button size="sm" variant="ghost" aria-expanded={panel === "versions"} aria-label={t("Versions of {name}", { name: doc.name })} onClick={() => toggle(doc.id, "versions")}>{t("Versions")}</Button>
                                <Button size="sm" variant="ghost" aria-expanded={panel === "actions"} aria-label={t("More actions for {name}", { name: doc.name })} onClick={() => toggle(doc.id, "actions")}>{t("Actions")}</Button>
                                <Button size="sm" variant="danger" aria-label={t("Move {name} to the trash", { name: doc.name })} onClick={() => void act(t("Moving {name} to the trash", { name: doc.name }), async () => {
                                  await docAction(doc.id, { action: "trash" });
                                  return t("Moved {name} to the trash.", { name: doc.name });
                                }, async () => {
                                  await docAction(doc.id, { action: "restore" });
                                })}>{t("Trash")}</Button>
                              </div>
                            </td>
                          </tr>,
                          panel === "actions" ? (
                            <DetailRow key={`${doc.id}-x`} colSpan={columns} onClose={() => setExpanded(null)}>
                              <div className="flex flex-wrap items-end gap-6">
                                <RenameForm initial={doc.name} label={t("New name for {name}", { name: doc.name })} onSave={(next) => act("Renaming", async () => {
                                  const r = await renameDoc(doc.id, next);
                                  return t("Renamed to {name}.", { name: r.name });
                                })} />
                                <MoveForm folders={folders} current={doc.folderId} label={t("Destination for {name}", { name: doc.name })} onMove={(to) => act("Moving", async () => {
                                  await docAction(doc.id, { action: "move", folderId: to });
                                  return t("Moved {name} to {value}.", { name: doc.name, value: pathOf(folders, to) || "the library" });
                                })} />
                                <Button size="sm" aria-label={t("Duplicate {name}", { name: doc.name })} onClick={() => void act("Duplicating", async () => {
                                  const r = await docAction(doc.id, { action: "duplicate" });
                                  return t("Made {name}.", { name: r.doc.name });
                                })}>{t("Duplicate")}</Button>
                              </div>
                            </DetailRow>
                          ) : panel === "versions" ? (
                            <DetailRow key={`${doc.id}-v`} colSpan={columns} onClose={() => setExpanded(null)}>
                              <VersionsPanel doc={doc} onChanged={() => void reload()} onNotice={(tone, text) => say(tone, text)} />
                            </DetailRow>
                          ) : null,
                        ];
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          ) : (
            <TrashView lib={lib} confirm={confirm} setConfirm={setConfirm} act={act} />
          )}
          {lib ? (
            <p className="text-xs text-faint">
              {t("Files {files} · earlier versions {versions} (up to {versionsKept} per document) · trash {trash} (kept {trashDays} days)", { files: formatBytes(lib.bytes.files), versions: formatBytes(lib.bytes.versions), versionsKept: lib.limits.versionsKept, trash: formatBytes(lib.bytes.trash), trashDays: lib.limits.trashDays })}
              {lib.storage.quotaBytes !== null ? ` · ${formatBytes(free)} free` : ""}
            </p>
          ) : null}
        </div>
      </Panel>
      {service?.installed ? (
        <p className="text-xs text-faint">
          {t("Editor service:")}{" "} {service.ready ? t("running") : service.canManage === false ? t("not running (an administrator starts it)") : t("stopped (starts when you open a document)")}
          {service.canManage === false ? "" : t(" · manage it on the Sidecar services page.")}
        </p>
      ) : null}
    </div>
  );
}

function TrashView({ lib, confirm, setConfirm, act }: {
  lib: OfficeLibrary | null;
  confirm: string | null;
  setConfirm: (id: string | null) => void;
  act: (label: string, fn: () => Promise<string | void>) => Promise<void>;
}) {
  const { t } = useT();
  if (!lib) return null;
  const { docs, folders } = lib.trash;
  if (!docs.length && !folders.length) return <EmptyState title={t("The trash is empty")}>{t("Documents and folders you move to the trash stay here for {trashDays} days.", { trashDays: lib.limits.trashDays })}</EmptyState>;
  const rows: { id: string; name: string; kind: "folder" | DocMeta["format"]; at: string; bytes: number | null; restore: () => Promise<unknown>; forever: () => Promise<unknown> }[] = [
    ...folders.map((f) => ({ id: f.id, name: f.name, kind: "folder" as const, at: f.trashedAt ?? f.updatedAt, bytes: null, restore: () => folderAction(f.id, { action: "restore" }), forever: () => deleteFolderForever(f.id) })),
    ...docs.map((d) => ({ id: d.id, name: d.name, kind: d.format, at: d.trashedAt ?? d.updatedAt, bytes: d.bytes, restore: () => docAction(d.id, { action: "restore" }), forever: () => deleteDocForever(d.id) })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted">{t("Items here still count toward your storage. They are deleted for good {trashDays} days after you trashed them.", { trashDays: lib.limits.trashDays })}</p>
        {confirm === "__all" ? (
          <span className="flex gap-2">
            <Button size="sm" variant="danger" onClick={() => {
              setConfirm(null);
              void act(t("Emptying the trash"), async () => {
                const r = await emptyTrash();
                return t("Deleted {docs} document(s) and {folders} folder(s) for good, freed {freedBytes}.", { docs: r.docs, folders: r.folders, freedBytes: formatBytes(r.freedBytes) });
              });
            }}>{t("Confirm: empty the trash")}</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("Keep")}</Button>
          </span>
        ) : (
          <Button size="sm" variant="danger" onClick={() => setConfirm("__all")}>{t("Empty trash")}</Button>
        )}
      </div>
      <div className="-mx-4 overflow-x-auto sm:-mx-5">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-faint">
              <th className="px-3 py-2 font-medium">{t("Name")}</th>
              <th className="px-3 py-2 font-medium">{t("Type")}</th>
              <th className="px-3 py-2 font-medium">{t("Size")}</th>
              <th className="px-3 py-2 font-medium">{t("Trashed (UTC)")}</th>
              <th className="px-3 py-2"><span className="sr-only">{t("Actions")}</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-line align-middle">
                <td className="px-3 py-2 font-medium text-ink">{row.name}</td>
                <td className="px-3 py-2"><Badge>{row.kind}</Badge></td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{row.bytes === null ? t("with contents") : formatBytes(row.bytes)}</td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{when(row.at)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap justify-end gap-2">
                    {confirm === row.id ? (
                      <>
                        <Button size="sm" variant="danger" onClick={() => {
                          setConfirm(null);
                          void act(t("Deleting {name}", { name: row.name }), async () => {
                            await row.forever();
                            return t("Deleted {name} for good.", { name: row.name });
                          });
                        }}>{t("Confirm delete")}{" "} {row.name}</Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirm(null)}>{t("Keep")}</Button>
                      </>
                    ) : (
                      <>
                        <Button size="sm" aria-label={t("Restore {name}", { name: row.name })} onClick={() => void act(t("Restoring {name}", { name: row.name }), async () => {
                          await row.restore();
                          return t("Restored {name}.", { name: row.name });
                        })}>{t("Restore")}</Button>
                        <Button size="sm" variant="danger" aria-label={t("Delete {name} for good", { name: row.name })} onClick={() => setConfirm(row.id)}>{t("Delete forever")}</Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
