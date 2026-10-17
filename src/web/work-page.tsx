import { PanelLoading } from "./components/panel-loading.js";
import { ImportPanel } from "./import-panel.js";
import { Textarea } from "./components/controls.js";
import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Input,
  Progress,
  RadioGroup,
  Select,
  Space,
  Spin,
  Table,
  Tag,
} from "./components/controls.js";
import { api, request, waitForWorkTask, downloadWorkFiles } from "./api.js";
import {
  OPERATIONS,
  executableOperation,
  operationLabel,
  READ_OPERATIONS,
  WorkRequestSchema,
} from "../shared/work.js";
import type {
  Operation,
  WorkTask,
  FileListing,
  UploadResult,
  ImportItem,
} from "../shared/work.js";
import type { PublicConfig } from "../shared/contracts.js";
import type { DeletePreview } from "../shared/archive-actions.js";
import type { Catalog } from "../shared/map.js";
import "./work.css";
import { useWorkspace } from "./workspace.js";
const statusLabel: Record<string, string> = {
  queued: "等待执行",
  running: "正在处理",
  succeeded: "已完成",
  partial: "部分失败",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};
function ErrorBox({ error }: { error: unknown }) {
  return error ? (
    <Alert
      type="error"

      title={error instanceof Error ? error.message : String(error)}
    />
  ) : null;
}
function resultText(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
export function TaskDetail({
  id,
  onSelect,
  automatic = false,
}: {
  automatic?: boolean;
  id: string;
  onSelect: (id: string) => void;
}) {
  const cache = useQueryClient();
  const workspace = useWorkspace();
  const [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const query = useQuery({
    queryKey: ["task", id],
    queryFn: ({ signal }) =>
      api<WorkTask>("/api/work/tasks/" + id, undefined, signal),
    refetchInterval: 1000,
  });
  const task = query.data;
  useEffect(() => {
    if (
      task &&
      (task.mode === "apply" || task.uploadsCleaned) &&
      !["queued", "running"].includes(task.status)
    ) {
      void cache.invalidateQueries({ queryKey: ["work-catalog"] });
      void cache.invalidateQueries({ queryKey: ["uploads"] });
    }
  }, [cache, task?.id, task?.mode, task?.status, task?.uploadsCleaned]);
  const refreshedTask = useRef("");
  useEffect(() => {
    if (
      task?.mode !== "apply" ||
      !["succeeded", "partial"].includes(task.status) ||
      ![
        "archive:push",
        "archive:delete",
        "archive:recover",
        "archive:migrate",
      ].includes(task.request.operation) ||
      !task.request.archive ||
      refreshedTask.current === task.id
    )
      return;
    refreshedTask.current = task.id;
    void workspace.refresh(task.request.archive).catch(setError);
    void cache.invalidateQueries({ queryKey: ["overview"] });
    void cache.invalidateQueries({ queryKey: ["overview-entries"] });
  }, [task, workspace, cache]);
  async function act(action: string) {
    setBusy(true);
    setError(undefined);
    try {
      const next = await api<WorkTask>(
        `/api/work/tasks/${id}/${action}`,
        action === "cancel" ? { revision: task!.revision } : {},
      );
      if (action !== "cancel") onSelect(next.id);
      await query.refetch();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  async function download(index: number, name: string) {
    try {
      const response = await request(
          `/api/work/tasks/${id}/download?index=${index}`,
        ),
        url = URL.createObjectURL(await response.blob()),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = name;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e);
    }
  }
  if (!task)
    return (
      <>
        <ErrorBox error={query.error} />
        <Spin />
      </>
    );
  const deletion = (
    task.output?.data as { deletion_preview?: DeletePreview } | undefined
  )?.deletion_preview;
  const importItems = (
    task.output?.data as { import_items?: ImportItem[] } | undefined
  )?.import_items;
  const executable =
    executableOperation(task.request.operation) &&
    !task.request.operation.startsWith("kml:") &&
    task.request.operation !== "archive:recover";
  const active = ["queued", "running"].includes(task.status),
    canApply =
      executable &&
      !automatic &&
      !task.uploadsCleaned &&
      !deletion?.dependencies.length &&
      !importItems?.some(
        (i) => i.status === "conflict" || i.status === "invalid",
      ) &&
      task.mode === "plan" &&
      task.status === "succeeded" &&
      !READ_OPERATIONS.includes(task.request.operation);
  return (
    <Card
      title={operationLabel(task.request.operation)}
      className="task-detail"
    >
      <Space wrap>
        <Tag
          color={
            task.status === "succeeded"
              ? "green"
              : task.status === "failed" || task.status === "partial"
                ? "red"
                : "blue"
          }
        >
          {task.mode === "plan" &&
          task.status === "succeeded" &&
          !READ_OPERATIONS.includes(task.request.operation)
            ? automatic
              ? "正在准备"
              : "校验完成"
            : task.request.operation === "archive:push" &&
                task.mode === "apply" &&
                task.status === "succeeded"
              ? "已入库"
              : statusLabel[task.status]}
        </Tag>
        <span className="ui-typography text-muted-foreground ">
          {new Date(task.createdAt).toLocaleString()}
        </span>
      </Space>
      <Progress
        percent={
          task.status === "succeeded"
            ? 100
            : task.progress.total
              ? Math.round(
                  (task.progress.completed / task.progress.total) * 100,
                )
              : 0
        }
        status={
          active
            ? "active"
            : task.status === "succeeded"
              ? "success"
              : undefined
        }
        format={() => `${task.progress.completed} / ${task.progress.total}`}
      />
      <details>
        <summary>高级：服务端路径与执行详情</summary>
        <Descriptions
          items={[
            {
              key: "inputs",
              label: "处理对象",
              children:
                task.request.inputs.join("\n") ||
                task.request.archive ||
                "归档",
            },
            ...(task.request.operation === "archive:delete"
              ? []
              : [
                  {
                    key: "output",
                    label: "输出位置",
                    children: task.request.output || "沿用源文件或归档目录",
                  },
                ]),
            {
              key: "mode",
              label: "当前阶段",
              children:
                task.mode === "plan"
                  ? "只检查与预览，不修改源文件"
                  : active
                    ? "正在执行已确认的预览"
                    : "执行已结束，请查看逐文件结果与日志",
            },
          ]}
        />
      </details>
      {task.request.operation === "archive:push" && (
        <p>
          分类：{task.request.options.category || "自动识别（见逐文件明细）"}。
          {task.mode === "plan"
            ? "预览不会写入轨迹库；请核对下面的重复、冲突及异常结果。"
            : "本批次在同一事务中入库；提交前失败整批回滚，成功提交后重新上传会识别为重复。"}
        </p>
      )}
      {task.status === "partial" && (
        <Alert
          type="warning"
          title={
            task.request.operation === "archive:push"
              ? "入库校验失败，本批次未入库；请修正异常文件后重新预览。"
              : "部分文件失败；已完成结果保留。请检查逐文件原因，重新预览后重试。"
          }
        />
      )}
      {!executable && (
        <Alert
          type="info"
          title="此历史操作已移除，仅可查看记录和下载已有结果"
        />
      )}
      {deletion && (
        <Alert
          type={deletion.dependencies.length ? "warning" : "info"}
          title={`将删除 ${deletion.path} 及 ${deletion.versions} 个版本`}
          description={
            <>
              <p>
                删除后不能从版本历史恢复。仍被其他轨迹使用的{" "}
                {deletion.shared_objects} 份共享内容会保留。
              </p>
              {deletion.dependencies.map((d) => (
                <p key={d.kind + d.id}>
                  阻塞依赖：
                  {d.kind === "project"
                    ? "项目"
                    : d.kind === "trajectory"
                      ? "轨迹"
                      : "待恢复操作"}{" "}
                  {d.detail}（{d.id}）
                </p>
              ))}
            </>
          }
        />
      )}
      {task.error && <Alert type="error" title={task.error.message} />}
      <ErrorBox error={error} />
      {task.uploadsCleaned && (
        <Alert
          type="info"
          title="上传暂存副本已自动清理；需要再次处理时请重新上传。"
        />
      )}
      <Space wrap className="work-actions">
        {canApply && (
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => void act("apply")}
          >
            {task.request.operation === "archive:push"
              ? "确认入库"
              : task.request.operation === "archive:delete"
                ? "确认删除"
                : "确认执行"}
          </Button>
        )}
        {active ? (
          <Button
            variant="destructive"
            loading={busy}
            onClick={() => void act("cancel")}
          >
            取消任务
          </Button>
        ) : executable &&
          !automatic &&
          !task.uploadsCleaned &&
          task.status !== "succeeded" ? (
          <Button loading={busy} onClick={() => void act("retry")}>
            {task.request.operation === "track:apply"
              ? "用原请求重试应用"
              : "重新校验"}
          </Button>
        ) : null}
        <Button onClick={() => void query.refetch()}>刷新状态</Button>
        {task.request.archive && (
          <Button
            onClick={() => {
              void workspace
                .refresh(task.request.archive!)
                .then(() => workspace.open("library", "imported"))
                .catch(setError);
            }}
          >
            {task.request.operation === "archive:push" && task.mode === "apply"
              ? "查看已导入轨迹"
              : "刷新轨迹库"}
          </Button>
        )}
      </Space>
      {importItems && (
        <section aria-label="入库逐文件预览">
          <p>
            预计新增 {importItems.filter((i) => i.status === "new").length}{" "}
            条，重复{" "}
            {importItems.filter((i) => i.status === "duplicate").length}{" "}
            条，冲突／异常{" "}
            {
              importItems.filter((i) =>
                ["conflict", "invalid"].includes(i.status),
              ).length
            }{" "}
            条。
          </p>
          {importItems.map((i, n) => (
            <article key={n}>
              <strong>{i.path.split(/[\\/]/).at(-1)}</strong>
              <p>
                {i.category ?? "分类未知"} · {i.reason}
              </p>
            </article>
          ))}
        </section>
      )}
      {task.result && (
        <Table
          tableLayout="fixed"
          rowKey={(row) => row.path}
          dataSource={task.result.items}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "文件",
              dataIndex: "path",
              render: (v: string) => (
                <span className="wrap-path" title={v}>
                  {v.split(/[\\/]/).at(-1)}
                </span>
              ),
            },
            {
              title: "结果",
              width: "28%",
              render: (_, row) =>
                row.status === "failed"
                  ? row.error.message
                  : row.status === "skipped"
                    ? row.reason
                    : task.mode === "plan"
                      ? "预览通过"
                      : "成功",
            },
          ]}
        />
      )}
      {task.output?.data !== undefined && (
        <details open={READ_OPERATIONS.includes(task.request.operation)}>
          <summary>检查结果与处理明细</summary>
          <pre className="work-output">{resultText(task.output.data)}</pre>
        </details>
      )}
      {task.request.operation.startsWith("track:") && (
        <Button onClick={() => workspace.open("library")}>
          前往轨迹库，在行程详情中编辑
        </Button>
      )}
      {!!task.output?.paths.length && (
        <section aria-label="结果文件">
          <h5 className="ui-typography ">
            {task.mode === "plan" ? "预计输出" : "结果文件"}
          </h5>
          {task.output.paths.map((file, index) => (
            <div className="work-result" key={file}>
              <span className="wrap-path">{file}</span>
              {task.mode === "apply" && !active && (
                <Button
                  size="sm"
                  onClick={() =>
                    void download(index, file.split(/[\\/]/).at(-1)!)
                  }
                >
                  下载
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {(task.request.operation.startsWith("kml:") ||
        task.output?.paths.some((p) => p.toLowerCase().endsWith(".kml"))) &&
        !active && (
          <Button
            onClick={() => {
              void workspace.inspect(id).catch(setError);
            }}
          >
            {task.mode === "plan" ? "地图检查输入轨迹" : "地图检查处理结果"}
          </Button>
        )}
      <details>
        <summary>日志（最近 500 条）</summary>
        <div className="work-log">
          {task.events
            .filter((e) => e.event.type === "log")
            .map(({ sequence, event }) => (
              <div key={sequence}>
                {event.type === "log" ? `${event.level}: ${event.message}` : ""}
              </div>
            ))}
        </div>
      </details>
    </Card>
  );
}
function FilePicker({
  value,
  onChange,
  roots,
  importing = false,
  onBusy,
}: {
  value: string;
  onChange: (value: string) => void;
  roots: string[];
  importing?: boolean;
  onBusy?: (busy: boolean) => void;
}) {
  const [source, setSource] = useState(importing ? "upload" : "server"),
    [folder, setFolder] = useState(roots[0] ?? ""),
    [browse, setBrowse] = useState(false),
    [upload, setUpload] = useState<UploadResult>(),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false);
  const listing = useQuery({
    queryKey: ["files", folder],
    queryFn: ({ signal }) =>
      api<FileListing>(
        "/api/work/files?path=" + encodeURIComponent(folder),
        undefined,
        signal,
      ),
    enabled: browse && !!folder,
  });
  const [uploadPercent, setUploadPercent] = useState(0);
  const [uploadName, setUploadName] = useState("");
  const [uploadedCount, setUploadedCount] = useState(0);
  const [uploadTotal, setUploadTotal] = useState(0);
  const [failedFiles, setFailedFiles] = useState<File[]>([]);
  const [fileResults, setFileResults] = useState<
    { name: string; error?: string }[]
  >([]);
  async function send(files: FileList | File[] | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(undefined);
    onBusy?.(true);
    setUploadTotal(files.length);
    setUploadedCount(0);
    setFailedFiles([]);
    setFileResults([]);
    try {
      let batch = upload;
      const paths: string[] = value.split("\n").filter(Boolean);
      for (const file of Array.from(files)) {
        try {
          if (importing && !file.name.toLowerCase().endsWith(".kml"))
            throw new Error("请选择 KML 文件");
          const token = document.querySelector<HTMLMetaElement>(
            'meta[name="tracktool-token"]',
          )!.content;
          setUploadName(file.name);
          setUploadPercent(0);
          const result = await new Promise<UploadResult>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open(
              "POST",
              "/api/work/uploads?name=" +
                encodeURIComponent(file.name) +
                (batch ? "&id=" + batch.id : ""),
            );
            xhr.setRequestHeader("X-Tracktool-Token", token);
            xhr.setRequestHeader("Content-Type", "application/octet-stream");
            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable)
                setUploadPercent(Math.round((e.loaded / e.total) * 100));
            };
            xhr.onerror = () => reject(new Error("上传连接中断，请重试此文件"));
            xhr.onload = () => {
              try {
                const result = JSON.parse(xhr.responseText) as UploadResult & {
                  error?: { message: string };
                };
                if (xhr.status >= 200 && xhr.status < 300) resolve(result);
                else reject(new Error(result.error?.message ?? "上传失败"));
              } catch {
                reject(new Error("上传响应无效，请重试"));
              }
            };
            xhr.send(file);
          });
          batch = { ...result, files: [...paths, ...result.files] };
          paths.push(...result.files);
          setUpload(batch);
          onChange(paths.join("\n"));
          setFileResults((old) => [...old, { name: file.name }]);
        } catch (e) {
          setFailedFiles((old) => [...old, file]);
          setFileResults((old) => [
            ...old,
            {
              name: file.name,
              error: e instanceof Error ? e.message : String(e),
            },
          ]);
        } finally {
          setUploadedCount((n) => n + 1);
        }
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
      onBusy?.(false);
    }
  }
  return (
    <Card title={importing ? "1 · 选择或拖入 KML" : "输入来源"}>
      {!importing && (
        <RadioGroup
          value={source}
          onValueChange={(e) => {
            setSource(e);
            onChange("");
          }}
          options={[
            { label: "服务端目录", value: "server" },
            { label: "从当前设备上传", value: "upload" },
          ]}
        />
      )}
      {!importing && source === "server" ? (
        <>
          <p className="ui-typography text-muted-foreground ">
            这些路径位于运行 Tracktool
            的电脑上。局域网访问时，可切换到上传当前设备的文件。
          </p>
          <Space wrap>
            <Select
              aria-label="开放目录"
              value={folder}
              options={roots.map((r) => ({ value: r, label: r }))}
              onChange={(v) => {
                setFolder(v);
                setBrowse(true);
              }}
              style={{ minWidth: 180, maxWidth: "100%" }}
            />
            <Button onClick={() => setBrowse(!browse)}>浏览服务端文件</Button>
          </Space>
          {browse && (
            <div className="file-browser">
              <span className="ui-typography wrap-path">{folder}</span>
              <Space wrap>
                <Button
                  disabled={
                    !listing.data || listing.data.roots.includes(folder)
                  }
                  onClick={() => setFolder(listing.data!.parent)}
                >
                  上一级
                </Button>
                <Button onClick={() => onChange(folder)}>选择此目录</Button>
              </Space>
              <ErrorBox error={listing.error} />
              {listing.isFetching && <Spin />}
              {listing.data?.entries.map((entry) => (
                <div key={entry.path}>
                  <Checkbox
                    checked={value.split("\n").includes(entry.path)}
                    onCheckedChange={(e) =>
                      onChange(
                        e
                          ? [
                              ...value.split("\n").filter(Boolean),
                              entry.path,
                            ].join("\n")
                          : value
                              .split("\n")
                              .filter((p) => p !== entry.path)
                              .join("\n"),
                      )
                    }
                  >
                    {entry.directory ? "目录" : "文件"} · {entry.name}
                  </Checkbox>
                  {entry.directory && (
                    <Button
                      variant="link"
                      onClick={() => setFolder(entry.path)}
                    >
                      打开
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <p className="ui-typography text-muted-foreground ">
            {importing
              ? "从当前设备上传 KML，原文件不会改变；入库结束后自动清理上传副本。"
              : "上传到独立暂存目录，处理后可下载结果；原设备上的文件不会改变。"}
            单文件上限 8 GiB。
          </p>
          <div
            className="upload-drop"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (!busy) void send(e.dataTransfer.files);
            }}
          >
            <input
              accept={importing ? ".kml" : undefined}
              aria-label="上传输入文件"
              type="file"
              multiple
              disabled={busy}
              onChange={(event) => void send(event.target.files)}
            />
            <p>也可将文件拖到这里</p>
          </div>
          {busy && (
            <span role="status">
              正在上传 {uploadedCount}/{uploadTotal}… {uploadName} ·{" "}
              {uploadPercent}%
            </span>
          )}
          {!!uploadTotal && (
            <Progress
              percent={Math.round((uploadedCount / uploadTotal) * 100)}
              format={() => `${uploadedCount}/${uploadTotal} 文件`}
            />
          )}
          {fileResults.map((r, i) => (
            <p key={i} role={r.error ? "alert" : "status"}>
              {r.name} · {r.error || "已上传到暂存区（尚未入库）"}
            </p>
          ))}
          {!!failedFiles.length && (
            <Button disabled={busy} onClick={() => void send(failedFiles)}>
              重试失败的上传（{failedFiles.length}）
            </Button>
          )}
          {upload && !importing && (
            <details>
              <summary>高级：暂存批次</summary>
              <Space wrap>
                <Button onClick={() => onChange(upload.directory)}>
                  选择整个上传目录
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    void api("/api/work/uploads/" + upload.id + "/cleanup", {})
                      .then(() => {
                        setUpload(undefined);
                        onChange("");
                      })
                      .catch(setError);
                  }}
                >
                  清理此批次暂存文件
                </Button>
              </Space>
            </details>
          )}
        </>
      )}
      <ErrorBox error={error} />
      {importing && (
        <ul>
          {value
            .split("\n")
            .filter(Boolean)
            .map((p) => (
              <li key={p}>
                {p.split(/[\\/]/).at(-1)}
                <Button
                  aria-label={`移除输入 ${p.split(/[\\/]/).at(-1)}`}
                  onClick={() =>
                    onChange(
                      value
                        .split("\n")
                        .filter((v) => v !== p)
                        .join("\n"),
                    )
                  }
                >
                  移除
                </Button>
              </li>
            ))}
        </ul>
      )}
      {!importing && (
        <details open>
          <summary>高级：完整服务端路径</summary>
          <label className="work-label" htmlFor="work-inputs">
            已选输入（每行一个完整路径）
          </label>
          <Textarea
            id="work-inputs"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={3}
          />
        </details>
      )}
    </Card>
  );
}
const textFields: Record<string, string> = {
  versionId: "历史版本 ID（留空下载当前版本）",
  name: "轨迹名称或完整归档成员路径",
  category: "轨迹分类",
};
const booleanFields: Record<string, string> = { keep: "保留入库的源文件" };
const fields: Partial<Record<Operation, string[]>> = {
  "archive:push": ["category", "keep"],
  "archive:download": ["name", "category", "versionId"],
  "archive:delete": ["name", "category"],
};
function CatalogPanel({
  archive,
  onAction,
}: {
  archive: string;
  onAction: (
    operation: "archive:download" | "archive:delete",
    name: string,
  ) => void;
}) {
  const [filter, setFilter] = useState(""),
    [kind, setKind] = useState("all");
  const catalog = useQuery({
    queryKey: ["work-catalog", archive],
    queryFn: ({ signal }) =>
      api<{
        catalog: Catalog;
        status: {
          entries: number;
          revision: number;
          pending: number;
          zip_fresh: boolean;
        };
      }>("/api/work/catalog", { archive }, signal),
    enabled: !!archive,
  });
  return (
    <Card
      title="轨迹库内容"
      extra={<Button onClick={() => void catalog.refetch()}>刷新归档</Button>}
    >
      <ErrorBox error={catalog.error} />
      {catalog.data && (
        <>
          <p className="ui-typography ">
            {catalog.data.status.entries} 条轨迹 · 修订{" "}
            {catalog.data.status.revision} · 待恢复{" "}
            {catalog.data.status.pending} · 备份
            {catalog.data.status.zip_fresh ? "已同步" : "需更新"}
          </p>
          <Space wrap>
            <Input
              aria-label="筛选归档轨迹"
              placeholder="搜索日期、名称或标签"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Select
              aria-label="轨迹分类"
              value={kind}
              onChange={setKind}
              options={["all", "Default", "Train", "Flight"].map((v) => ({
                value: v,
                label: v === "all" ? "全部分类" : v,
              }))}
            />
          </Space>
          <Table
            rowKey="entry"
            dataSource={catalog.data.catalog.entries.filter(
              (e) =>
                (kind === "all" || e.kind === kind) &&
                e.entry.toLowerCase().includes(filter.toLowerCase()),
            )}
            pagination={{ pageSize: 10 }}
            columns={[
              {
                title: "轨迹",
                dataIndex: "name",
                render: (name: string) => (
                  <span className="wrap-path">{name}</span>
                ),
              },
              { title: "分类", dataIndex: "kind" },
              {
                title: "操作",
                render: (_, entry) => (
                  <Space>
                    <Button
                      onClick={() => onAction("archive:download", entry.entry)}
                    >
                      下载
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => onAction("archive:delete", entry.entry)}
                    >
                      删除
                    </Button>
                  </Space>
                ),
              },
            ]}
          />
        </>
      )}
    </Card>
  );
}
export function ArchiveWorkPage({
  fixedOperation,
  entry,
  entries,
}: {
  fixedOperation?: Operation;
  entry?: string;
  entries?: string[];
}) {
  if (fixedOperation === "archive:push") return <ImportPanel />;
  return (
    <FileOperation
      fixedOperation={fixedOperation}
      entry={entry}
      entries={entries}
    />
  );
}
function FileOperation({
  fixedOperation,
  entry,
  entries,
}: {
  fixedOperation?: Operation;
  entry?: string;
  entries?: string[];
}) {
  const workspace = useWorkspace();
  const bootstrap = useQuery({
    queryKey: ["work-bootstrap"],
    queryFn: ({ signal }) =>
      api<{ roots: string[]; archive: string; config: PublicConfig }>(
        "/api/work/bootstrap",
        undefined,
        signal,
      ),
  });
  const [operation, setOperation] = useState<Operation>(
      fixedOperation ?? "archive:backup",
    ),
    [inputs, setInputs] = useState(""),
    [output, setOutput] = useState(""),
    [options, setOptions] = useState<Record<string, unknown>>(
      entry ? { name: entry } : {},
    ),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [params, setParams] = useSearchParams();
  const archivePath = workspace.archive || bootstrap.data?.archive || "";
  const [id, setId] = useState<string | null>(() =>
    !fixedOperation && params.get("panel") === "archive"
      ? params.get("task")
      : null,
  );
  useEffect(() => {
    if (fixedOperation || params.get("panel") !== "archive") return;
    const requested = params.get("task");
    if (requested) setId(requested);
    else if (id) setParams({ panel: "archive", task: id }, { replace: true });
  }, [params, id, setParams, fixedOperation]);
  const setTask = (next: string) => {
    setId(next);
    if (!fixedOperation) setParams({ panel: "archive", task: next });
  };
  const names = Object.entries(OPERATIONS).filter(
    ([key]) =>
      key.startsWith("archive:") &&
      ![
        "archive:init",
        "archive:import-zip",
        "archive:recover",
        "archive:status",
        "archive:migrate",
      ].includes(key),
  );
  const choose = (next: Operation) => {
    setOperation(next);
    setOutput("");
    setOptions({});
  };
  function update(key: string, value: unknown) {
    setOptions((old) => ({ ...old, [key]: value }));
  }
  async function preview() {
    setBusy(true);
    setError(undefined);
    try {
      const body = WorkRequestSchema.parse({
        operation,
        inputs:
          operation.startsWith("archive:") &&
          !["archive:push", "archive:import-zip"].includes(operation)
            ? []
            : inputs
                .split("\n")
                .map((p) => p.trim())
                .filter(Boolean),
        archive: archivePath || undefined,
        output: ["archive:download", "archive:delete"].includes(operation)
          ? undefined
          : output || undefined,
        options: { ...options, ...(entries ? { entries } : {}) },
      });
      const task = await api<WorkTask>("/api/work/preview", body);
      setTask(task.id);
      if (
        ["archive:backup", "archive:rebuild", "archive:download"].includes(
          operation,
        )
      ) {
        await waitForWorkTask(task.id);
        const applied = await api<WorkTask>(
          `/api/work/tasks/${task.id}/apply`,
          {},
        );
        setTask(applied.id);
        await downloadWorkFiles(await waitForWorkTask(applied.id));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  const deletionStarted = useRef("");
  useEffect(() => {
    if (
      operation !== "archive:delete" ||
      !archivePath ||
      !entry ||
      deletionStarted.current === entry
    )
      return;
    deletionStarted.current = entry;
    void preview();
  }, [operation, archivePath, entry]);
  return (
    <>
      <div className="work-main">
        {!fixedOperation && <h1 className="ui-typography ">轨迹库管理</h1>}
        <p className="ui-typography text-muted-foreground ">
          {operation === "archive:delete"
            ? "确认影响范围后删除轨迹及其历史版本。"
            : "选择导出选项，完成后自动下载；也可在结果中再次下载。"}
        </p>
        <ErrorBox error={bootstrap.error} />
        {!bootstrap.data ? (
          bootstrap.isError ? null : (
            <PanelLoading>正在读取轨迹库信息…</PanelLoading>
          )
        ) : (
          <>
            <div className="work-grid">
              <section>
                <Card
                  title={
                    fixedOperation ? operationLabel(fixedOperation) : "处理操作"
                  }
                >
                  {!fixedOperation && (
                    <>
                      <label className="work-label" htmlFor="work-operation">
                        操作
                      </label>
                      <Select
                        id="work-operation"
                        value={operation}
                        onChange={choose}
                        options={names.map(([value, label]) => ({
                          value,
                          label,
                        }))}
                        style={{ width: "100%" }}
                      />
                    </>
                  )}
                  {![
                    "archive:download",
                    "archive:delete",
                    "archive:push",
                    "archive:status",
                    "archive:recover",
                    "archive:migrate",
                  ].includes(operation) && (
                    <>
                      <label className="work-label" htmlFor="work-output">
                        输出路径（可选）
                      </label>
                      <Input
                        id="work-output"
                        value={output}
                        onChange={(e) => setOutput(e.target.value)}
                        placeholder="留空使用源目录或归档目录"
                      />
                    </>
                  )}
                  <div className="work-fields">
                    {(fields[operation] ?? [])
                      .filter(
                        (key) => !entry || !["name", "category"].includes(key),
                      )
                      .map((key) =>
                        booleanFields[key] ? (
                          <Checkbox
                            key={key}
                            checked={!!options[key]}
                            onCheckedChange={(e) => update(key, e)}
                          >
                            {booleanFields[key]}
                          </Checkbox>
                        ) : (
                          <div key={key}>
                            <label
                              className="work-label"
                              htmlFor={"option-" + key}
                            >
                              {textFields[key]}
                            </label>
                            {key === "category" ? (
                              <Select
                                id={"option-" + key}
                                clearable
                                value={options[key] as string | undefined}
                                onChange={(v) => update(key, v)}
                                options={["Default", "Train", "Flight"].map(
                                  (v) => ({ value: v, label: v }),
                                )}
                              />
                            ) : (
                              <Input
                                id={"option-" + key}
                                value={(options[key] as string) ?? ""}
                                onChange={(e) =>
                                  update(key, e.target.value || undefined)
                                }
                              />
                            )}
                          </div>
                        ),
                      )}
                  </div>
                  <ErrorBox error={error} />
                  {operation === "archive:delete" && !!error && (
                    <Button loading={busy} onClick={() => void preview()}>
                      重新检查删除范围
                    </Button>
                  )}
                  {operation !== "archive:delete" && (
                    <Button
                      variant="default"
                      className="work-actions"
                      loading={busy}
                      onClick={() => void preview()}
                    >
                      {operation === "archive:download" ? "下载轨迹" : "导出"}
                    </Button>
                  )}
                </Card>
                {["archive:push", "archive:import-zip"].includes(operation) && (
                  <FilePicker
                    roots={bootstrap.data.roots}
                    value={inputs}
                    onChange={(value) => {
                      setInputs(value);
                    }}
                  />
                )}
              </section>
              <section>
                {id ? (
                  <TaskDetail
                    id={id}
                    onSelect={setTask}
                    automatic={operation !== "archive:delete"}
                  />
                ) : (
                  <Card title="操作结果">
                    <p className="ui-typography text-muted-foreground ">
                      完成后将在这里显示结果。
                    </p>
                  </Card>
                )}
              </section>
            </div>
            {!fixedOperation && archivePath && (
              <CatalogPanel
                archive={archivePath}
                onAction={(action, name) => {
                  choose(action);
                  setOptions({ name });
                  window.scrollTo({ top: 0, behavior: "smooth" });
                }}
              />
            )}
          </>
        )}
      </div>
    </>
  );
}
