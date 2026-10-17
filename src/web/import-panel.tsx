import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CircleAlert,
  Ellipsis,
  FileUp,
  LoaderCircle,
  Upload,
  X,
} from "lucide-react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { Alert, Button, Input, Select } from "./components/controls.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";
import { api } from "./api.js";
import { useWorkspace } from "./workspace.js";
import type { ImportItem, UploadResult, WorkTask } from "../shared/work.js";

type Category = "Default" | "Train" | "Flight";
type Stage =
  | "queued"
  | "uploading"
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
  category?: Category;
  stage: Stage;
  progress: number;
  path?: string;
  upload?: string;
  planId?: string;
  applyId?: string;
  applying?: boolean;
  result?: ImportItem;
  error?: string;
};
const categories = [
  { value: "auto", label: "自动识别" },
  { value: "Default", label: "普通轨迹" },
  { value: "Train", label: "火车" },
  { value: "Flight", label: "飞机" },
];
const labels: Record<string, string> = {
  Default: "普通轨迹",
  Train: "火车",
  Flight: "飞机",
};
const stages: Record<Stage, string> = {
  queued: "等待上传",
  uploading: "正在上传",
  reading: "正在读取轨迹",
  saving: "正在保存",
  done: "已导入",
  duplicate: "重复轨迹已跳过",
  error: "需要处理",
  cancelled: "已取消",
  uncertain: "待确认结果",
};
const completed = (row: Row) =>
  row.stage === "done" || row.stage === "duplicate";
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

export function ImportPanel() {
  const workspace = useWorkspace();
  const cache = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const current = useRef<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const dragDepth = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const xhr = useRef<XMLHttpRequest | undefined>(undefined);
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
          if (!row.applying && !row.applyId) void cleanup(row);
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
  async function process(row: Row) {
    row.error = undefined;
    // A lost apply response must resume the same idempotent operation.
    if (!row.applying && !row.applyId) {
      if (!/\.kml$/i.test(row.file.name)) throw new Error("请选择 KML 文件。");
      if (!/^[^/\\:\x00-\x1f]+\.kml$/i.test(row.name) || row.name.length > 240)
        throw new Error(
          "名称应以 .kml 结尾，不能包含路径分隔符，且不超过 240 个字符。",
        );
      if (row.file.size > 8 * 1024 ** 3)
        throw new Error("文件超过 8 GiB，请拆分后上传。");
      if (!row.path) row.path = (await send(row)).files[0];
      if (stop.current) return;
      row.stage = "reading";
      publish();
      const queued = row.planId
        ? await api<WorkTask>(`/api/work/tasks/${row.planId}`)
        : await api<WorkTask>("/api/work/preview", {
            operation: "archive:push",
            archive: workspace.archive,
            inputs: [row.path],
            options: {
              importFiles: [
                { path: row.path, name: row.name, category: row.category },
              ],
            },
          });
      row.planId = queued.id;
      const plan = await settle(queued, true);
      if (stop.current) return;
      const result = (
        plan.output?.data as { import_items?: ImportItem[] } | undefined
      )?.import_items?.[0];
      row.result = result;
      if (
        plan.status !== "succeeded" ||
        !result ||
        ["invalid", "conflict"].includes(result.status) ||
        plan.uploadsCleaned
      ) {
        const reason = (
          result?.reason ??
          plan.error?.message ??
          "未能读取轨迹，请重试。"
        )
          .split(row.path ?? "\u0000")
          .join(row.file.name);
        row.planId = undefined;
        await cleanup(row);
        throw new Error(reason);
      }
      if (result.status === "duplicate") {
        row.stage = "duplicate";
        row.planId = undefined;
        await cleanup(row);
        return;
      }
    }
    row.stage = "saving";
    publish();
    row.applying = true;
    let applied: WorkTask;
    try {
      applied = row.applyId
        ? await api<WorkTask>(`/api/work/tasks/${row.applyId}`)
        : await api<WorkTask>(`/api/work/tasks/${row.planId}/apply`, {});
    } catch (error) {
      // HTTP rejection is definitive; network and decoding failures may follow a commit.
      if (
        !row.applyId &&
        !(error instanceof TypeError || error instanceof SyntaxError)
      ) {
        row.applying = false;
        row.planId = undefined;
        await cleanup(row);
      }
      throw error;
    }
    row.applyId = applied.id;
    const done = await settle(applied, false);
    row.applying = false;
    row.applyId = undefined;
    row.planId = undefined;
    const result = (
      done.output?.data as { import_items?: ImportItem[] } | undefined
    )?.import_items?.[0];
    row.result = result ?? row.result;
    await cleanup(row);
    if (done.status !== "succeeded")
      throw new Error(done.error?.message ?? "保存失败，请重试。");
    row.stage = result?.status === "duplicate" ? "duplicate" : "done";
  }
  async function run(ids: string[]) {
    if (busy.current) return;
    busy.current = true;
    stop.current = false;
    setRunning(true);
    setStopping(false);
    setError("");
    const batch = current.current.filter(
      (row) => ids.includes(row.id) && !completed(row),
    );
    batch.forEach((row) => {
      row.stage = "queued";
      row.error = undefined;
    });
    publish();
    try {
      for (const row of batch) {
        if (stop.current) break;
        try {
          await process(row);
        } catch (error) {
          row.stage =
            row.applying || row.applyId
              ? "uncertain"
              : stop.current
                ? "cancelled"
                : "error";
          row.error =
            row.stage === "uncertain"
              ? "暂时无法确认导入结果，请查询结果后继续。"
              : row.stage === "cancelled"
                ? undefined
                : message(error)
                    .split(row.path ?? "\u0000")
                    .join(row.file.name);
        }
        if (stop.current && !completed(row) && row.stage !== "uncertain") {
          row.stage = "cancelled";
          row.planId = undefined;
          await cleanup(row);
        }
        publish();
      }
    } finally {
      for (const row of batch)
        if (row.stage === "queued") row.stage = "cancelled";
      xhr.current = undefined;
      busy.current = false;
      publish();
      if (mounted.current) {
        setRunning(false);
        setStopping(false);
      }
      if (!mounted.current)
        for (const row of current.current) {
          if (!row.applying && !row.applyId) void cleanup(row);
        }
      if (batch.some(completed)) {
        void cache.invalidateQueries({ queryKey: ["overview"] });
        void cache.invalidateQueries({ queryKey: ["overview-entries"] });
        void workspace.refresh(workspace.archive, { quiet: true }).catch(() => {
          /* Import is committed; a refresh can retry independently. */
        });
      }
    }
  }
  function choose(files: FileList | null) {
    if (!files?.length || busy.current) return;
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
      void run(added.map((row) => row.id));
    } catch (error) {
      setError(`无法准备上传：${message(error)}`);
    } finally {
      if (input.current) input.current.value = "";
    }
  }
  function change(id: string, patch: Partial<Row>) {
    const row = current.current.find((row) => row.id === id);
    if (!row || busy.current || row.stage === "uncertain") return;
    Object.assign(row, patch, { planId: undefined, result: undefined });
    publish();
  }
  function remove(id: string) {
    if (busy.current) return;
    const row = current.current.find((row) => row.id === id);
    if (!row || row.stage === "uncertain") return;
    void cleanup(row);
    current.current = current.current.filter((row) => row.id !== id);
    publish();
  }
  const imported = rows.filter((row) => row.stage === "done");
  const skipped = rows.filter((row) => row.stage === "duplicate").length;
  const retryable = rows.filter((row) =>
    ["error", "cancelled"].includes(row.stage),
  );
  const processed = rows.filter(
    (row) => !working(row) && row.stage !== "queued",
  ).length;
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
        disabled={running}
        onChange={(event) => choose(event.target.files)}
      />
      <div
        className={`import-dropzone${rows.length ? " compact" : ""}${dragging ? " dragging" : ""}`}
        aria-disabled={running}
        onDragEnter={(event) => {
          event.preventDefault();
          if (!running && event.dataTransfer.types.includes("Files")) {
            dragDepth.current++;
            setDragging(true);
          }
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = running ? "none" : "copy";
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
          disabled={running}
          onClick={() => input.current?.click()}
        >
          {rows.length ? "添加文件" : "选择文件"}
        </Button>
      </div>
      {rows.length > 0 && (
        <>
          <div className="import-summary" role="status">
            <span>
              {running
                ? `已处理 ${processed} / ${rows.length} 个文件`
                : `共 ${rows.length} 个文件`}
            </span>
            {running && (
              <Button
                variant="ghost"
                size="sm"
                disabled={stopping}
                onClick={() => {
                  stop.current = true;
                  xhr.current?.abort();
                  setStopping(true);
                }}
              >
                {stopping ? "正在停止…" : "停止剩余上传"}
              </Button>
            )}
          </div>
          {stopping && (
            <p className="overview-hint">
              正在保存的轨迹完成后停止，已导入的轨迹会保留。
            </p>
          )}
          <section aria-label="上传文件列表" className="import-files">
            {rows.map((row) => (
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
                    ) : completed(row) ? (
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
                      {(row.category ?? row.result?.category) && (
                        <span className="import-category">
                          {labels[row.category ?? row.result!.category!]}
                        </span>
                      )}
                      <span>
                        {row.stage === "uploading"
                          ? `上传中 ${row.progress}%`
                          : row.result?.status === "conflict" &&
                              row.stage === "error"
                            ? "名称冲突"
                            : stages[row.stage]}
                      </span>
                    </div>
                  </div>
                  <div className="import-row-actions">
                    {row.stage === "uncertain" ? (
                      <Button
                        size="sm"
                        disabled={running}
                        onClick={() => void run([row.id])}
                      >
                        查询导入结果
                      </Button>
                    ) : completed(row) ? (
                      row.result?.entryId &&
                      workspace.showTrack && (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={running}
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
                            size="sm"
                            disabled={running}
                            onClick={() => void run([row.id])}
                          >
                            重试
                          </Button>
                        )}
                        <Popover>
                          <PopoverTrigger asChild>
                            <Button
                              variant="ghost"
                              size="icon"
                              disabled={running}
                              aria-label={`${row.file.name} 更多操作`}
                            >
                              <Ellipsis aria-hidden="true" />
                            </Button>
                          </PopoverTrigger>
                          <PopoverContent
                            align="end"
                            className="import-options-popover"
                          >
                            <p className="font-medium">修改名称或分类</p>
                            <div className="import-file-options">
                              <label>
                                导入名称
                                <Input
                                  aria-label={`${row.file.name} 导入名称`}
                                  value={row.name}
                                  onChange={(event) =>
                                    change(row.id, { name: event.target.value })
                                  }
                                />
                              </label>
                              <label>
                                分类
                                <Select
                                  aria-label={`${row.file.name} 分类`}
                                  value={row.category ?? "auto"}
                                  options={categories}
                                  onChange={(value) =>
                                    change(row.id, {
                                      category:
                                        value === "auto"
                                          ? undefined
                                          : (value as Category),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <PopoverPrimitive.Close asChild>
                              <Button
                                variant="default"
                                onClick={() => void run([row.id])}
                              >
                                保存并重试
                              </Button>
                            </PopoverPrimitive.Close>
                            <PopoverPrimitive.Close asChild>
                              <Button
                                variant="ghost"
                                onClick={() => remove(row.id)}
                                aria-label={`移除 ${row.file.name}`}
                              >
                                <X aria-hidden="true" />
                                移除文件
                              </Button>
                            </PopoverPrimitive.Close>
                          </PopoverContent>
                        </Popover>
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
                {row.error && <p className="import-file-error">{row.error}</p>}
              </article>
            ))}
          </section>
          {!running && (
            <div className="import-actions">
              <p role="status">
                已导入 {imported.length} 条轨迹
                {skipped ? `，跳过 ${skipped} 条重复轨迹` : ""}。
                {retryable.length > 0 && ` ${retryable.length} 个文件待处理。`}
              </p>
              {imported.length > 0 && (
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
              {retryable.length > 0 && (
                <Button
                  onClick={() => void run(retryable.map((row) => row.id))}
                >
                  重试失败文件
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
