import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Input, Select } from "./components/controls.js";
import { api } from "./api.js";
import { useWorkspace } from "./workspace.js";
import type { ImportItem, UploadResult, WorkTask } from "../shared/work.js";

type Category = "Default" | "Train" | "Flight";
type Row = {
  id: string;
  file: File;
  name: string;
  category?: Category;
  path?: string;
  result?: ImportItem;
  status: string;
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
// getRandomValues also works on LAN HTTP pages, where randomUUID is unavailable.
function uploadId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const active = (task: WorkTask) => ["queued", "running"].includes(task.status);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const pause = () => new Promise((resolve) => setTimeout(resolve, 300));

export function ImportPanel() {
  const workspace = useWorkspace();
  const queryClient = useQueryClient();
  const [rows, setRows] = useState<Row[]>([]);
  const [phase, setPhase] = useState<
    "idle" | "checking" | "applying" | "done" | "uncertain"
  >("idle");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<WorkTask>();
  const [dirty, setDirty] = useState(false);
  const [cancelled, setCancelled] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const stop = useRef(false);
  const mounted = useRef(true);
  const xhr = useRef<XMLHttpRequest | undefined>(undefined);
  const uploads = useRef(new Set<string>());
  const pendingPreview = useRef<string | undefined>(undefined);
  const pendingApply = useRef<string | undefined>(undefined);
  const busyUI =
    phase === "checking" || phase === "applying" || phase === "uncertain";
  const fresh = rows.filter((row) => row.result?.status === "new").length;
  const duplicates = rows.filter(
    (row) => row.result?.status === "duplicate",
  ).length;
  const problems = rows.filter(
    (row) =>
      row.error || ["invalid", "conflict"].includes(row.result?.status ?? ""),
  ).length;

  async function cleanup() {
    for (const id of [...uploads.current]) {
      try {
        await api(`/api/work/uploads/${id}/cleanup`, {});
        uploads.current.delete(id);
      } catch {
        /* Active operations retain their files; terminal tasks also clean server-side. */
      }
    }
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stop.current = true;
      xhr.current?.abort();
      if (!busy.current) void cleanup();
    };
  }, []);
  useEffect(() => {
    if (!rows.length || phase === "done") return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [rows.length, phase]);

  async function settle(task: WorkTask, cancellable: boolean) {
    let current = task;
    while (active(current)) {
      if (cancellable && stop.current && !current.cancelRequested) {
        try {
          await api(`/api/work/tasks/${current.id}/cancel`, {
            revision: current.revision,
          });
        } catch {
          /* A concurrent progress update may change the revision; retry with the next read. */
        }
      }
      await pause();
      current = await api<WorkTask>(`/api/work/tasks/${current.id}`);
    }
    return current;
  }
  function send(row: Row, update: (status: string) => void) {
    const id = uploadId();
    uploads.current.add(id);
    return new Promise<UploadResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      xhr.current = request;
      request.open(
        "POST",
        `/api/work/uploads?name=${encodeURIComponent(row.file.name)}&id=${id}`,
      );
      request.setRequestHeader(
        "X-Tracktool-Token",
        document.querySelector<HTMLMetaElement>('meta[name="tracktool-token"]')
          ?.content ?? "",
      );
      request.setRequestHeader("Content-Type", "application/octet-stream");
      request.upload.onprogress = (event) => {
        if (event.lengthComputable)
          update(`上传中 ${Math.round((event.loaded / event.total) * 100)}%`);
      };
      request.onerror = () => reject(new Error("上传连接中断，请重试"));
      request.onabort = () => reject(new Error("已取消"));
      request.onload = () => {
        try {
          const data = JSON.parse(request.responseText) as UploadResult & {
            error?: { message: string };
          };
          if (request.status >= 200 && request.status < 300) resolve(data);
          else reject(new Error(data.error?.message ?? "上传失败，请重试"));
        } catch (error) {
          reject(error);
        }
      };
      request.send(row.file);
    });
  }
  async function check(next: Row[]) {
    if (busy.current) return;
    busy.current = true;
    stop.current = false;
    setCancelled(false);
    setPhase("checking");
    setError("");
    setPreview(undefined);
    setDirty(false);
    let current = next.map(
      (row) =>
        ({
          ...row,
          path: undefined,
          result: undefined,
          error: undefined,
          status: "等待上传",
        }) as Row,
    );
    const publish = () => {
      if (mounted.current) setRows([...current]);
    };
    publish();
    let keep = false;
    let skipped = false;
    try {
      await cleanup();
      for (let index = 0; index < current.length; index++) {
        if (stop.current) break;
        const row = current[index]!;
        try {
          if (!/\.kml$/i.test(row.file.name))
            throw new Error("请选择 KML 文件");
          if (
            !/^[^/\\:\x00-\x1f]+\.kml$/i.test(row.name) ||
            row.name.length > 240
          )
            throw new Error(
              "导入名称应以 .kml 结尾，不能包含路径分隔符，且不超过 240 个字符",
            );
          if (row.file.size > 8 * 1024 ** 3)
            throw new Error("文件超过 8 GiB，请拆分后上传");
          const result = await send(row, (status) => {
            row.status = status;
            publish();
          });
          row.path = result.files[0];
          row.status = "待校验";
        } catch (error) {
          row.error = message(error);
          row.status = "上传失败";
        }
        publish();
      }
      if (stop.current) return;
      // Never submit a partial selection when even one upload failed.
      if (current.some((row) => row.error)) {
        setError("有文件上传失败，本批次尚未导入。请重试或移除失败文件。");
        setDirty(true);
        return;
      }
      if (!current.length) return;
      current.forEach((row) => {
        row.status = "校验中";
      });
      publish();
      const queued = await api<WorkTask>("/api/work/preview", {
        operation: "archive:push",
        archive: workspace.archive,
        inputs: current.map((row) => row.path!),
        options: {
          importFiles: current.map((row) => ({
            path: row.path!,
            name: row.name,
            category: row.category,
          })),
        },
      });
      const task = await settle(queued, true);
      if (stop.current) return;
      const items = (
        task.output?.data as { import_items?: ImportItem[] } | undefined
      )?.import_items;
      current = current.map((row) => {
        const result = items?.find((item) => item.path === row.path);
        return {
          ...row,
          result,
          status: result
            ? {
                new: "待导入",
                duplicate: "将跳过",
                conflict: "名称冲突",
                invalid: "需要处理",
              }[result.status]
            : "校验失败",
          error: result
            ? undefined
            : (task.error?.message ?? "校验未完成，请重试"),
        };
      });
      publish();
      keep =
        task.status === "succeeded" &&
        !task.uploadsCleaned &&
        current.every(
          (row) =>
            row.result && ["new", "duplicate"].includes(row.result.status),
        );
      if (keep && current.every((row) => row.result?.status === "duplicate")) {
        skipped = true;
        keep = false;
        current.forEach((row) => {
          row.status = "已跳过";
        });
        publish();
      } else if (keep) setPreview(task);
      else if (!items?.length)
        setError(task.error?.message ?? "校验未完成，请重试");
    } catch (error) {
      if (!stop.current) {
        setError(message(error));
        setDirty(true);
      }
    } finally {
      xhr.current = undefined;
      if (!keep || stop.current) await cleanup();
      busy.current = false;
      if (mounted.current) {
        if (stop.current) {
          setRows(
            current.map((row) => ({
              ...row,
              status: "已取消",
              result: undefined,
              error: undefined,
            })),
          );
          setDirty(true);
        }
        setPhase(skipped ? "done" : "idle");
      }
    }
  }
  function choose(files: FileList | null) {
    if (!files?.length || busy.current || busyUI) return;
    try {
      const added = Array.from(files).map((file): Row => ({
        id: uploadId(),
        file,
        name: file.name,
        status: "等待上传",
      }));
      void check([...rows, ...added]);
    } catch (error) {
      setError(`无法准备上传：${message(error)}`);
    } finally {
      if (input.current) input.current.value = "";
    }
  }

  function change(id: string, patch: Partial<Row>) {
    setRows((old) =>
      old.map((row) =>
        row.id === id ? { ...row, ...patch, status: "待重新校验" } : row,
      ),
    );
    setDirty(true);
    setPreview(undefined);
  }
  async function finish(task: WorkTask) {
    const done = await settle(task, false);
    if (done.status !== "succeeded") {
      pendingApply.current = undefined;
      throw new Error(done.error?.message ?? "导入未完成，请重新校验后重试");
    }
    pendingApply.current = undefined;
    const items =
      (done.output?.data as { import_items?: ImportItem[] } | undefined)
        ?.import_items ?? [];
    setRows((old) =>
      old.map((row) => {
        const result =
          items.find((item) => item.path === row.path) ?? row.result;
        return {
          ...row,
          result,
          status: result?.status === "duplicate" ? "已跳过" : "已导入",
        };
      }),
    );
    setPhase("done");
    setPreview(undefined);
    await cleanup();
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
    void queryClient.invalidateQueries({ queryKey: ["overview-entries"] });
    void workspace.refresh(workspace.archive).catch(() => {
      /* Import already committed; list refresh can retry independently. */
    });
  }
  async function apply() {
    if (
      busy.current ||
      (!preview && !pendingApply.current && !pendingPreview.current)
    )
      return;
    busy.current = true;
    setError("");
    setPhase("applying");
    try {
      let task: WorkTask;
      if (pendingApply.current)
        task = await api<WorkTask>(`/api/work/tasks/${pendingApply.current}`);
      else {
        pendingPreview.current ??= preview!.id;
        task = await api<WorkTask>(
          `/api/work/tasks/${pendingPreview.current}/apply`,
          {},
        );
        pendingApply.current = task.id;
        pendingPreview.current = undefined;
      }
      await finish(task);
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof SyntaxError))
        pendingPreview.current = undefined;
      const uncertain = !!(pendingApply.current || pendingPreview.current);
      setError(
        uncertain ? "暂时无法确认导入结果，请查询结果后继续。" : message(error),
      );
      setPhase(uncertain ? "uncertain" : "idle");
      if (!uncertain) {
        setDirty(true);
        setPreview(undefined);
        await cleanup();
      }
    } finally {
      busy.current = false;
    }
  }
  return (
    <div className="import-panel">
      <p>选择 KML 文件，检查后导入。设备上的原文件始终保留。</p>
      {error && <Alert type="error" title={error} />}
      {phase !== "done" && (
        <div
          className="import-dropzone"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            choose(event.dataTransfer.files);
          }}
        >
          <input
            ref={input}
            type="file"
            accept=".kml"
            multiple
            aria-label="上传输入文件"
            disabled={busyUI}
            onChange={(event) => choose(event.target.files)}
          />
          <span>选择或拖入 KML，可多选</span>
        </div>
      )}
      {rows.length > 0 && (
        <section aria-label="上传文件列表" className="import-files">
          {rows.map((row) => (
            <article
              key={row.id}
              className="import-file"
              aria-label={row.file.name}
            >
              <div className="import-file-heading">
                <strong>{row.file.name}</strong>
                <span role="status">{row.status}</span>
              </div>
              {phase !== "done" && (
                <>
                  <details>
                    <summary>修改名称或分类</summary>
                    <div className="import-file-options">
                      <label>
                        导入名称
                        <Input
                          aria-label={`${row.file.name} 导入名称`}
                          value={row.name}
                          disabled={busyUI}
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
                          disabled={busyUI}
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
                  </details>
                  <Button
                    variant="ghost"
                    disabled={busyUI}
                    aria-label={`移除 ${row.file.name}`}
                    onClick={() =>
                      void check(rows.filter((item) => item.id !== row.id))
                    }
                  >
                    移除
                  </Button>
                </>
              )}
              {!dirty && row.result?.category && !row.category && (
                <small>
                  识别为{labels[row.result.category] ?? row.result.category}
                </small>
              )}
              {row.error && <p className="error-text">{row.error}</p>}
              {!dirty && row.result && row.result.status !== "new" && (
                <p>
                  {row.result.status === "duplicate"
                    ? phase === "done"
                      ? "重复轨迹已跳过"
                      : "重复轨迹，将跳过"
                    : row.result.reason
                        .split(row.path ?? "\u0000")
                        .join(row.file.name)}
                </p>
              )}
              {!dirty && row.result?.status === "conflict" && (
                <small>
                  同名轨迹：{row.result.member?.split("/").at(-1)}（
                  {labels[row.result.category ?? ""]}）
                </small>
              )}
              {phase === "done" &&
                row.result?.entryId &&
                workspace.showTrack && (
                  <Button
                    variant="outline"
                    onClick={() => workspace.showTrack?.(row.result!.entryId!)}
                  >
                    查看轨迹
                  </Button>
                )}
            </article>
          ))}
        </section>
      )}
      {phase === "done" ? (
        <div className="import-actions" role="status">
          <p>
            已导入 {fresh} 条轨迹
            {duplicates ? `，跳过 ${duplicates} 条重复轨迹` : ""}。
          </p>
          <Button
            onClick={() => {
              setRows([]);
              setPhase("idle");
              setError("");
              setDirty(false);
            }}
          >
            继续上传
          </Button>
        </div>
      ) : (
        rows.length > 0 && (
          <div className="import-actions">
            {phase === "checking" ? (
              <>
                <p role="status">正在上传并校验文件…</p>
                <Button
                  disabled={cancelled}
                  onClick={() => {
                    stop.current = true;
                    xhr.current?.abort();
                    setCancelled(true);
                  }}
                >
                  {cancelled ? "正在取消…" : "取消上传"}
                </Button>
              </>
            ) : phase === "applying" ? (
              <p role="status">正在导入，请稍候…</p>
            ) : phase === "uncertain" ? (
              <Button onClick={() => void apply()}>查询导入结果</Button>
            ) : (
              <>
                {dirty ? (
                  <p>文件列表或设置已变更，请重新校验后导入。</p>
                ) : problems > 0 ? (
                  <p>有 {problems} 个文件需要处理；修正或移除后才能导入。</p>
                ) : (
                  <p>
                    待导入 {fresh} 条
                    {duplicates ? `，将跳过 ${duplicates} 条重复轨迹` : ""}。
                  </p>
                )}
                {(dirty || !preview) && (
                  <Button onClick={() => void check(rows)}>重新校验</Button>
                )}
                <Button
                  variant="default"
                  disabled={!preview || dirty || problems > 0 || fresh === 0}
                  onClick={() => void apply()}
                >
                  导入 {fresh} 条轨迹
                </Button>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
