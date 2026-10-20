import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  CircleMinus,
  Ellipsis,
  FileUp,
  LoaderCircle,
  RotateCcw,
  Upload,
  X,
} from "lucide-react";
import { Alert, Button, Input } from "./components/controls.js";
import { ImportTagPicker } from "./components/import-tag-picker.js";
import { isRegisteredTag } from "./components/tag-picker.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog.js";
import { api, readConfig } from "./api.js";
import { importError } from "./import-error.js";
import { useWorkspace } from "./workspace.js";
import type { ImportItem, UploadResult, WorkTask } from "../shared/work.js";
import type { PublicConfig } from "../shared/contracts.js";

type Stage =
  | "queued"
  | "uploading"
  | "ready"
  | "reading"
  | "saving"
  | "done"
  | "duplicate"
  | "error"
  | "cancelled"
  | "uncertain";
type Row = {
  id: string;
  file: File;
  name: string;
  tag?: string;
  detectedTag?: string;
  stage: Stage;
  progress: number;
  path?: string;
  upload?: string;
  reusableUntil?: number;
  finished?: boolean;
  result?: ImportItem;
  error?: string;
};
const stages: Record<Stage, string> = {
  queued: "等待上传",
  uploading: "正在上传",
  reading: "正在检查轨迹",
  ready: "检查通过",
  saving: "正在保存",
  done: "已导入",
  duplicate: "重复轨迹",
  error: "导入失败",
  cancelled: "已取消",
  uncertain: "导入结果待确认",
};
const completed = (row: Row) =>
  row.stage === "done" || (row.stage === "duplicate" && row.finished === true);
const working = (row: Row) =>
  ["uploading", "reading", "saving"].includes(row.stage);
const active = (task: WorkTask) => ["queued", "running"].includes(task.status);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const size = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
// getRandomValues also works on LAN HTTP pages, where randomUUID is unavailable.
function uploadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function ImportOptions({
  row,
  config,
  detail,
  onSave,
}: {
  row: Row;
  config?: PublicConfig;
  detail?: string;
  onSave: (patch: Pick<Row, "name" | "tag">) => void;
}) {
  const [name, setName] = useState(row.name);
  const [tag, setTag] = useState(row.tag);
  const sourceTag = row.detectedTag ?? row.result?.sourceTag;
  return (
    <>
      <DialogHeader className="import-options-header">
        <DialogTitle>编辑轨迹信息</DialogTitle>
      </DialogHeader>
      <div className="import-options-body">
        {row.stage === "error" && detail && (
          <div className="import-file-error" role="note" aria-label="错误说明">
            <p className="font-medium">错误说明</p>
            <p>{detail}</p>
          </div>
        )}
        <div className="import-file-options">
          <label>
            导入名称
            <Input
              aria-label={`${row.file.name} 导入名称`}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <ImportTagPicker
            config={config}
            sourceTag={sourceTag}
            value={tag}
            onChange={setTag}
            pending={["queued", "uploading", "reading"].includes(row.stage)}
          />
        </div>
      </div>
      <div className="import-options-actions">
        <DialogClose asChild>
          <Button
            variant="default"
            disabled={!isRegisteredTag(config, tag ?? sourceTag)}
            onClick={() => onSave({ name, tag })}
          >
            保存
          </Button>
        </DialogClose>
      </div>
    </>
  );
}

export function ImportPanel() {
  const workspace = useWorkspace();
  const cache = useQueryClient();
  const config = useQuery({
    queryKey: ["config"],
    queryFn: () => readConfig(),
  });
  const [rows, setRows] = useState<Row[]>([]);
  const [editSession, setEditSession] = useState(0);
  const current = useRef<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const batch = useRef<
    | { rows: Row[]; planId: string; applyId?: string; applying: boolean }
    | undefined
  >(undefined);
  const busy = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | undefined>(undefined);
  const checking = running && !batch.current?.applying;
  useEffect(() => {
    if (!checking) return;
    const timer = window.setTimeout(() => setShowCancel(true), 1000);
    return () => window.clearTimeout(timer);
  }, [checking]);
  function publish() {
    if (mounted.current) setRows(current.current.map((row) => ({ ...row })));
  }
  async function cleanup(row: Row) {
    if (!row.upload) return;
    try {
      await api(`/api/work/uploads/${row.upload}/cleanup`, {});
      row.upload = undefined;
      row.path = undefined;
    } catch {
      /* Active tasks and server expiration own any remaining temporary files. */
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
      xhr.current?.abort();
      if (!busy.current)
        for (const row of current.current) {
          if (!batch.current?.applying) void cleanup(row);
        }
    };
  }, []);
  const unresolved = rows.some((row) => !completed(row));
  useEffect(() => {
    if (!unresolved) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [unresolved]);

  async function settle(task: WorkTask, cancellable: boolean) {
    let next = task;
    while (active(next)) {
      if (cancellable && stop.current && !next.cancelRequested) {
        try {
          await api(`/api/work/tasks/${next.id}/cancel`, {
            revision: next.revision,
          });
        } catch {
          /* Retry cancellation with the latest revision. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      next = await api<WorkTask>(`/api/work/tasks/${next.id}`);
    }
    return next;
  }
  async function send(row: Row) {
    await cleanup(row);
    if (stop.current) throw new Error("已取消");
    row.upload = uploadId();
    row.stage = "uploading";
    row.progress = 0;
    publish();
    return new Promise<UploadResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      xhr.current = request;
      request.open(
        "POST",
        `/api/work/uploads?name=${encodeURIComponent(row.file.name)}&id=${row.upload}`,
      );
      request.setRequestHeader(
        "X-Tracktool-Token",
        document.querySelector<HTMLMetaElement>('meta[name="tracktool-token"]')
          ?.content ?? "",
      );
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          row.progress = Math.round((event.loaded / event.total) * 100);
          publish();
        }
      };
      request.onerror = () => reject(new Error("上传连接中断，请重试。"));
      request.onabort = () => reject(new Error("已取消"));
      request.onload = () => {
        try {
          const result = JSON.parse(request.responseText) as UploadResult & {
            error?: { message: string };
          };
          if (request.status >= 200 && request.status < 300) resolve(result);
          else reject(new Error(result.error?.message ?? "上传失败，请重试。"));
        } catch (error) {
          reject(error);
        }
      };
      request.send(row.file);
    });
  }
  function finishRun() {
    xhr.current = undefined;
    busy.current = false;
    publish();
    if (mounted.current) {
      setRunning(false);
      setShowCancel(false);
      setStopping(false);
    } else if (!batch.current?.applying) {
      for (const row of current.current) void cleanup(row);
    }
  }
  function results(task: WorkTask) {
    return (
      (task.output?.data as { import_items?: ImportItem[] } | undefined)
        ?.import_items ?? []
    );
  }
  function fail(row: Row, error: unknown) {
    row.stage = stop.current ? "cancelled" : "error";
    row.error = stop.current
      ? undefined
      : message(error)
          .split(row.path ?? "\u0000")
          .join(row.file.name);
  }
  async function check(changed: string[] = []) {
    if (busy.current || batch.current?.applying) return;
    batch.current = undefined;
    const pending = current.current.filter((row) => !completed(row));
    if (!pending.length) {
      publish();
      return;
    }
    if (pending.length > 500) {
      setError("一次最多检查 500 个文件，请移除多余文件。");
      publish();
      return;
    }
    busy.current = true;
    stop.current = false;
    setRunning(true);
    setStopping(false);
    setError("");
    const uploaded: Row[] = [];
    for (const row of pending) {
      if (changed.includes(row.id) || !row.path) {
        row.stage = "queued";
        row.error = undefined;
      }
    }
    publish();
    try {
      for (const row of pending) {
        if (stop.current) break;
        try {
          if (!/\.kml$/i.test(row.file.name))
            throw new Error("请选择 KML 文件。");
          if (
            !/^[^/\\:\x00-\x1f]+\.kml$/i.test(row.name) ||
            row.name.length > 240
          )
            throw new Error(
              "名称应以 .kml 结尾，不能包含路径分隔符，且不超过 240 个字符。",
            );
          if (row.file.size > 8 * 1024 ** 3)
            throw new Error("文件超过 8 GiB，请拆分后上传。");
          const reuse =
            row.path && (row.reusableUntil ?? 0) > Date.now() + 1000;
          if (!reuse) {
            row.path = (await send(row)).files[0];
            row.reusableUntil = Date.now() + 14 * 60_000;
          }
          if (!row.path) throw new Error("上传失败，请重试。");
          uploaded.push(row);
          if (!reuse || changed.includes(row.id)) row.stage = "reading";
        } catch (error) {
          fail(row, error);
        }
        publish();
      }
      if (!stop.current && uploaded.length) {
        const plan = await settle(
          await api<WorkTask>("/api/work/preview", {
            operation: "archive:push",
            archive: workspace.archive,
            inputs: uploaded.map((row) => row.path),
            options: {
              retainUploads: true,
              importFiles: uploaded.map((row) => ({
                path: row.path,
                name: row.name,
                tag: row.tag,
              })),
            },
          }),
          true,
        );
        for (const row of uploaded) {
          row.reusableUntil =
            ["succeeded", "partial"].includes(plan.status) &&
            !plan.uploadsCleaned
              ? plan.expiresAt
                ? Date.parse(plan.expiresAt)
                : Date.parse(plan.updatedAt) + 15 * 60_000
              : 0;
          const result = results(plan).find((item) => item.path === row.path);
          row.result = result;
          if (result?.sourceTag) row.detectedTag = result.sourceTag;
          if (
            stop.current ||
            !["succeeded", "partial"].includes(plan.status) ||
            !result ||
            ["invalid", "conflict"].includes(result.status)
          ) {
            fail(
              row,
              result?.reason ?? plan.error?.message ?? "未能检查轨迹，请重试。",
            );
          } else {
            row.error = undefined;
            row.stage = result.status === "duplicate" ? "duplicate" : "ready";
          }
        }
        if (
          !stop.current &&
          plan.status === "succeeded" &&
          !plan.uploadsCleaned &&
          pending.every((row) => ["ready", "duplicate"].includes(row.stage))
        ) {
          if (pending.every((row) => row.stage === "duplicate")) {
            for (const row of pending) row.finished = true;
          } else {
            batch.current = { rows: pending, planId: plan.id, applying: false };
          }
        }
      }
    } catch (error) {
      for (const row of uploaded) {
        row.reusableUntil = 0;
        fail(row, error);
      }
    } finally {
      if (!batch.current) {
        for (const row of pending) {
          if (stop.current && !completed(row)) row.stage = "cancelled";
          if (stop.current || completed(row)) await cleanup(row);
        }
      }
      finishRun();
    }
  }
  async function confirmImport() {
    const confirmed = batch.current;
    if (busy.current || !confirmed) return;
    busy.current = true;
    stop.current = false;
    setRunning(true);
    setError("");
    for (const row of confirmed.rows) row.stage = "saving";
    publish();
    confirmed.applying = true;
    try {
      let applied: WorkTask;
      try {
        // Retrying a lost response resumes the same idempotent batch operation.
        applied = confirmed.applyId
          ? await api<WorkTask>(`/api/work/tasks/${confirmed.applyId}`)
          : await api<WorkTask>(
              `/api/work/tasks/${confirmed.planId}/apply`,
              {},
            );
      } catch (error) {
        if (
          !confirmed.applyId &&
          !(error instanceof TypeError || error instanceof SyntaxError)
        )
          confirmed.applying = false;
        throw error;
      }
      confirmed.applyId = applied.id;
      const done = await settle(applied, false);
      confirmed.applying = false;
      if (done.status !== "succeeded")
        throw new Error(
          done.error?.message ?? "保存失败，请重新检查后再导入。",
        );
      for (const row of confirmed.rows) {
        const result = results(done).find((item) => item.path === row.path);
        row.result = result ?? row.result;
        row.stage = row.result?.status === "duplicate" ? "duplicate" : "done";
        row.finished = true;
      }
      void cache.invalidateQueries({ queryKey: ["overview"] });
      void cache.invalidateQueries({ queryKey: ["overview-entries"] });
      void workspace.refresh(workspace.archive, { quiet: true }).catch(() => {
        /* Import is committed; a refresh can retry independently. */
      });
    } catch (error) {
      for (const row of confirmed.rows) {
        if (confirmed.applying) {
          row.stage = "uncertain";
          row.error = "暂时无法确认导入结果，请查询结果后继续。";
        } else {
          fail(row, error);
        }
      }
    } finally {
      if (!confirmed.applying) {
        batch.current = undefined;
        for (const row of confirmed.rows) await cleanup(row);
      }
      finishRun();
    }
  }
  function choose(files: FileList | null) {
    if (!files?.length || busy.current || batch.current?.applying) return;
    try {
      const added = Array.from(files).map((file): Row => ({
        id: uploadId(),
        file,
        name: file.name,
        stage: "queued",
        progress: 0,
      }));
      current.current = [...current.current, ...added];
      publish();
      void check(added.map((row) => row.id));
    } catch (error) {
      setError(`无法准备上传：${message(error)}`);
    } finally {
      if (input.current) input.current.value = "";
    }
  }
  function change(id: string, patch: Partial<Row>) {
    const row = current.current.find((row) => row.id === id);
    if (!row || busy.current || batch.current?.applying) return;
    Object.assign(row, patch);
    void check([id]);
  }
  function remove(id: string) {
    if (busy.current || batch.current?.applying) return;
    const row = current.current.find((row) => row.id === id);
    if (!row || row.stage === "uncertain") return;
    void cleanup(row);
    current.current = current.current.filter((row) => row.id !== id);
    publish();
    void check();
  }
  const imported = rows.filter((row) => row.stage === "done");
  const skipped = rows.filter((row) => row.stage === "duplicate").length;
  const failed = rows.filter((row) => row.stage === "error").length;
  const cancelled = rows.filter((row) => row.stage === "cancelled").length;
  const uncertain = rows.filter((row) => row.stage === "uncertain").length;
  const locked = running || uncertain > 0;
  const ready = rows.filter((row) => row.stage === "ready").length;
  const summary = running
    ? `共${rows.length}个文件，${batch.current?.applying ? "正在导入" : "正在检查"}…`
    : [
        `共${rows.length}个文件`,
        imported.length > 0 && `已导入${imported.length}个`,
        ready > 0 && `待导入${ready}个`,
        skipped > 0 &&
          `${rows.every(completed) ? "跳过重复" : "重复"}${skipped}个`,
        failed > 0 && `待处理${failed}个`,
        cancelled > 0 && `已取消${cancelled}个`,
        uncertain > 0 && `待确认${uncertain}个`,
      ]
        .filter(Boolean)
        .join("，") + "。";
  return (
    <div className="import-panel" data-empty={rows.length === 0}>
      {error && <Alert type="error" title={error} />}
      <input
        ref={input}
        className="sr-only"
        tabIndex={-1}
        type="file"
        accept=".kml"
        multiple
        aria-label="上传输入文件"
        disabled={locked}
        onChange={(event) => choose(event.target.files)}
      />
      <div
        className={`import-dropzone${rows.length ? " compact" : ""}${dragging ? " dragging" : ""}`}
        aria-disabled={locked}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!locked && event.dataTransfer.types.includes("Files")) {
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = locked ? "none" : "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          if (--dragDepth.current <= 0) {
            dragDepth.current = 0;
            setDragging(false);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          choose(event.dataTransfer.files);
        }}
      >
        <Upload className="import-upload-icon" aria-hidden="true" />
        <div>
          {rows.length > 0 && <strong>添加更多轨迹</strong>}
          <span>支持格式：.kml</span>
        </div>
        <Button
          variant={rows.length ? "outline" : "default"}
          disabled={locked}
          onClick={() => input.current?.click()}
        >
          {rows.length ? "添加文件" : "选择文件"}
        </Button>
      </div>
      {rows.length > 0 && (
        <>
          <section aria-label="上传文件列表" className="import-files">
            {rows.map((row) => {
              const failure = importError(
                row.error,
                row.result?.status === "conflict",
              );
              return (
                <article
                  key={row.id}
                  className="import-file"
                  aria-label={row.file.name}
                  data-stage={row.stage}
                >
                  <div className="import-file-main">
                    <span className="import-state-icon" aria-hidden="true">
                      {working(row) ? (
                        <LoaderCircle className="animate-spin" />
                      ) : row.stage === "duplicate" ? (
                        <CircleMinus />
                      ) : row.stage === "done" ? (
                        <Check />
                      ) : ["error", "uncertain"].includes(row.stage) ? (
                        <CircleAlert />
                      ) : (
                        <FileUp />
                      )}
                    </span>
                    <div className="import-file-info">
                      <strong title={row.name}>{row.name}</strong>
                      <div className="import-file-meta">
                        <span>{size(row.file.size)}</span>
                        {(row.tag ?? row.result?.tag) && (
                          <span className="import-category">
                            {row.tag ?? row.result!.tag}
                          </span>
                        )}
                        <span>
                          {row.stage === "uploading"
                            ? `上传中 ${row.progress}%`
                            : row.stage === "error"
                              ? failure.label
                              : stages[row.stage]}
                        </span>
                      </div>
                    </div>
                    <div className="import-row-actions">
                      {completed(row) ? (
                        row.result?.entryId &&
                        workspace.showTrack && (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={locked}
                            onClick={() =>
                              workspace.showTrack?.(row.result!.entryId!)
                            }
                          >
                            查看轨迹
                          </Button>
                        )
                      ) : (
                        <>
                          {["error", "cancelled"].includes(row.stage) && (
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={locked}
                              title="重试"
                              aria-label={`重试 ${row.file.name}`}
                              onClick={() => void check([row.id])}
                            >
                              <RotateCcw aria-hidden="true" />
                            </Button>
                          )}
                          <Dialog
                            onOpenChange={(open) => {
                              // Reset drafts even if the previous close animation is still running.
                              if (open) setEditSession((value) => value + 1);
                            }}
                          >
                            <DialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                disabled={locked}
                                aria-label={`${row.file.name} 更多操作`}
                              >
                                <Ellipsis aria-hidden="true" />
                              </Button>
                            </DialogTrigger>
                            <DialogContent
                              aria-describedby={undefined}
                              className="import-options-dialog translate-x-0 translate-y-0 sm:-translate-x-1/2 sm:-translate-y-1/2"
                            >
                              <ImportOptions
                                key={editSession}
                                row={row}
                                config={config.data}
                                detail={failure.detail}
                                onSave={(patch) => change(row.id, patch)}
                              />
                            </DialogContent>
                          </Dialog>
                          <Button
                            variant="ghost"
                            size="icon"
                            disabled={locked}
                            title="移除文件"
                            aria-label={`移除 ${row.file.name}`}
                            onClick={() => remove(row.id)}
                          >
                            <X aria-hidden="true" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  {row.stage === "uploading" && (
                    <progress
                      className="import-progress"
                      value={row.progress}
                      max={100}
                      aria-label={`${row.file.name} 上传进度`}
                    />
                  )}
                </article>
              );
            })}
          </section>
          <div className="import-actions">
            <div className="import-summary">
              <p role="status">{summary}</p>
            </div>
            {stopping && (
              <p className="overview-hint">
                正在取消检查，尚未确认的轨迹不会导入。
              </p>
            )}
            {uncertain > 0 ? (
              <Button disabled={running} onClick={() => void confirmImport()}>
                查询导入结果
              </Button>
            ) : (
              (unresolved || checking) && (
                <Button
                  variant={checking ? "outline" : "default"}
                  disabled={
                    checking
                      ? !showCancel || stopping
                      : running || !batch.current || ready === 0
                  }
                  onClick={() => {
                    if (checking) {
                      stop.current = true;
                      xhr.current?.abort();
                      setStopping(true);
                    } else {
                      void confirmImport();
                    }
                  }}
                >
                  {checking
                    ? stopping
                      ? "正在取消…"
                      : showCancel
                        ? "取消检查"
                        : "检查中…"
                    : batch.current?.applying
                      ? "正在导入…"
                      : "导入"}
                </Button>
              )
            )}
            {!running && imported.length > 0 && (
              <Button
                variant="default"
                onClick={() => {
                  const ids = imported.flatMap((row) =>
                    row.result?.entryId ? [row.result.entryId] : [],
                  );
                  if (workspace.showTracks) workspace.showTracks(ids);
                  else workspace.open("library", "imported");
                }}
              >
                查看已导入轨迹
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
