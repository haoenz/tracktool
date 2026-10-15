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
  InputNumber,
  Progress,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { api, request } from "./api.js";
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
} from "../shared/work.js";
import type { PublicConfig } from "../shared/contracts.js";
import type { DeletePreview } from "../shared/archive-actions.js";
import type { Catalog } from "../shared/map.js";
import "./work.css";
import { useWorkspace } from "./workspace.js";
import TrackEditor from "./track-editor.js";
export default function WorkPage({ group }: { group: "archive" | "tracks" }) {
  return group === "tracks" ? (
    <Tabs
      destroyOnHidden
      defaultActiveKey="journey"
      items={[
        { key: "journey", label: "库内行程编辑", children: <TrackEditor /> },
        {
          key: "files",
          label: "独立文件工具",
          children: <FileWorkPage group="tracks" />,
        },
      ]}
    />
  ) : (
    <FileWorkPage group="archive" />
  );
}
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
      showIcon
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
}: {
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
      task?.mode === "apply" &&
      !["queued", "running"].includes(task.status)
    ) {
      void cache.invalidateQueries({ queryKey: ["work-catalog"] });
      void cache.invalidateQueries({ queryKey: ["uploads"] });
    }
  }, [cache, task?.id, task?.mode, task?.status]);
  const refreshedTask = useRef("");
  useEffect(() => {
    if (
      task?.mode !== "apply" ||
      task.status !== "succeeded" ||
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
  const executable = executableOperation(task.request.operation);
  const active = ["queued", "running"].includes(task.status),
    canApply =
      executable &&
      !deletion?.dependencies.length &&
      task.mode === "plan" &&
      task.status === "succeeded" &&
      !READ_OPERATIONS.includes(task.request.operation);
  return (
    <Card
      title={`${task.mode === "plan" ? "预览" : "执行"} · ${operationLabel(task.request.operation)}`}
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
            ? "预览完成"
            : statusLabel[task.status]}
        </Tag>
        <Typography.Text type="secondary">
          {new Date(task.createdAt).toLocaleString()}
        </Typography.Text>
        <Button type="link" onClick={() => workspace.open("tasks", id)}>
          查看处理记录
        </Button>
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
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: "inputs",
            label: "处理对象",
            children:
              task.request.inputs.join("\n") || task.request.archive || "归档",
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
      <Space wrap className="work-actions">
        {canApply && (
          <Button
            type="primary"
            danger={task.request.operation === "archive:delete"}
            loading={busy}
            onClick={() => void act("apply")}
          >
            确认执行此预览
          </Button>
        )}
        {active ? (
          <Button danger loading={busy} onClick={() => void act("cancel")}>
            取消任务
          </Button>
        ) : executable ? (
          <Button loading={busy} onClick={() => void act("retry")}>
            {task.request.operation === "track:apply"
              ? "用原请求重试应用"
              : "重新预览 / 重试"}
          </Button>
        ) : null}
        <Button onClick={() => void query.refetch()}>刷新状态</Button>
        {task.request.archive && (
          <Button
            onClick={() => {
              void workspace
                .refresh(task.request.archive!)
                .then(() => workspace.open("library"))
                .catch(setError);
            }}
          >
            刷新轨迹库
          </Button>
        )}
      </Space>
      {canApply && (
        <Typography.Paragraph type="secondary">
          {task.request.operation === "track:preview"
            ? "编辑预览有效期 24 小时；应用已保存产物，来源变化时需重新预览。"
            : "预览有效期 15 分钟。执行前会再次检查文件、配置与归档；发生变化时需要重新预览。"}
        </Typography.Paragraph>
      )}
      {task.result && (
        <Table
          size="small"
          tableLayout="fixed"
          rowKey={(row) => row.path}
          dataSource={task.result.items}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "文件",
              dataIndex: "path",
              render: (v: string) => <span className="wrap-path">{v}</span>,
            },
            {
              title: "结果",
              width: "28%",
              render: (_, row) =>
                row.status === "failed"
                  ? row.error.message
                  : row.status === "skipped"
                    ? row.reason
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
        <Button onClick={() => workspace.open("tracks", id)}>
          打开行程编辑与预览
        </Button>
      )}
      {!!task.output?.paths.length && (
        <section aria-label="结果文件">
          <Typography.Title level={5}>
            {task.mode === "plan" ? "预计输出" : "结果文件"}
          </Typography.Title>
          {task.output.paths.map((file, index) => (
            <div className="work-result" key={file}>
              <span className="wrap-path">{file}</span>
              {task.mode === "apply" && !active && (
                <Button
                  size="small"
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
}: {
  value: string;
  onChange: (value: string) => void;
  roots: string[];
}) {
  const [source, setSource] = useState("server"),
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
  async function send(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(undefined);
    try {
      let batch = upload;
      const paths: string[] = [...(batch?.files ?? [])];
      for (const file of Array.from(files)) {
        const token = document.querySelector<HTMLMetaElement>(
          'meta[name="tracktool-token"]',
        )!.content;
        const response = await fetch(
          "/api/work/uploads?name=" +
            encodeURIComponent(file.name) +
            (batch ? "&id=" + batch.id : ""),
          {
            method: "POST",
            headers: {
              "X-Tracktool-Token": token,
              "Content-Type": "application/octet-stream",
            },
            body: file,
          },
        );
        const result = (await response.json()) as UploadResult & {
          error?: { message: string };
        };
        if (!response.ok) throw new Error(result.error?.message ?? "上传失败");
        batch = { ...result, files: [...paths, ...result.files] };
        paths.push(...result.files);
        setUpload(batch);
        onChange(paths.join("\n"));
      }
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card size="small" title="输入来源">
      <Radio.Group
        value={source}
        onChange={(e) => setSource(e.target.value)}
        options={[
          { label: "服务端目录", value: "server" },
          { label: "从当前设备上传", value: "upload" },
        ]}
      />
      {source === "server" ? (
        <>
          <Typography.Paragraph type="secondary">
            这些路径位于运行 Tracktool
            的电脑上。局域网访问时，可切换到上传当前设备的文件。
          </Typography.Paragraph>
          <Space wrap>
            <Select
              virtual={false}
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
              <Typography.Text className="wrap-path">{folder}</Typography.Text>
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
                    onChange={(e) =>
                      onChange(
                        e.target.checked
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
                    <Button type="link" onClick={() => setFolder(entry.path)}>
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
          <Typography.Paragraph type="secondary">
            上传到独立暂存目录，处理后可下载结果；原设备上的文件不会改变。单文件上限
            8 GiB。
          </Typography.Paragraph>
          <input
            aria-label="上传输入文件"
            type="file"
            multiple
            disabled={busy}
            onChange={(event) => void send(event.target.files)}
          />
          {busy && <span role="status"> 正在上传…</span>}
          {upload && (
            <Space wrap>
              <Button onClick={() => onChange(upload.directory)}>
                选择整个上传目录
              </Button>
              <Button
                danger
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
          )}
        </>
      )}
      <ErrorBox error={error} />
      <label className="work-label" htmlFor="work-inputs">
        已选输入（每行一个完整路径）
      </label>
      <Input.TextArea
        id="work-inputs"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoSize={{ minRows: 2, maxRows: 5 }}
      />
    </Card>
  );
}
const textFields: Record<string, string> = {
  versionId: "历史版本 ID（留空下载当前版本）",
  name: "轨迹名称或完整归档成员路径",
  tag: "活动标签",
  position: "坐标（纬度 经度，或 DMS）",
  make: "相机厂商",
  model: "相机型号",
  by: "时间偏移（例如 -1h30m）",
  offset: "时区偏移（例如 +08:00）",
  failedFolder: "失败文件夹名",
  language: "地名语言",
  source: "采用的时间来源",
};
const numberFields: Record<string, string> = {
  altitude: "海拔（米）",
  delta: "海拔偏移（米）",
  maxSeconds: "最大时间差 / 间隔（秒）",
  maxDistance: "GPS 核对距离（米）",
  gapSeconds: "拆分时间间隔（秒）",
  gapMeters: "拆分距离间隔（米）",
  speedMps: "漂移速度阈值（米/秒）",
  jumpMeters: "跳点距离（米）",
  returnMeters: "回归距离（米）",
};
const booleanFields: Record<string, string> = {
  overwrite: "写标签时不创建首次备份",
  parallel: "并行处理",
  force: "强制更新已有 GPS",
  verify: "核对已有 GPS",
  multiday: "匹配前后一天轨迹",
  keep: "保留入库的源文件",
  create: "缺少活动标签时创建",
  auto: "自动检测处理点",
  connected: "连接合并轨迹",
};
const fields: Partial<Record<Operation, string[]>> = {
  "archive:push": ["category", "keep"],
  "archive:download": ["name", "category", "versionId"],
  "archive:delete": ["name", "category"],
  "kml:set-tag": ["tag", "create"],
  "kml:split": ["auto", "points", "gapSeconds", "gapMeters"],
  "kml:prune": [
    "auto",
    "points",
    "speedMps",
    "jumpMeters",
    "returnMeters",
    "maxSeconds",
  ],
  "kml:merge": ["keep", "connected"],
  "exif:set": [
    "position",
    "altitude",
    "make",
    "model",
    "tags",
    "overwrite",
    "parallel",
  ],
  "exif:show-missing": ["missingTags", "parallel"],
  "exif:geotag": [
    "maxSeconds",
    "maxDistance",
    "overwrite",
    "parallel",
    "force",
    "verify",
    "multiday",
    "failedFolder",
  ],
  "exif:fill-altitude": ["overwrite", "parallel", "failedFolder"],
  "exif:set-location": ["language", "overwrite", "parallel", "failedFolder"],
  "exif:shift-time": ["by", "offset", "overwrite", "parallel"],
  "exif:shift-altitude": ["delta", "overwrite", "parallel"],
  "exif:to-mp4": ["policy", "offset", "source", "make", "model", "parallel"],
  "exif:repair": ["parallel"],
  "exif:repair-vid": [
    "policy",
    "offset",
    "source",
    "make",
    "model",
    "parallel",
  ],
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
          <Typography.Paragraph>
            {catalog.data.status.entries} 条轨迹 · 修订{" "}
            {catalog.data.status.revision} · 待恢复{" "}
            {catalog.data.status.pending} · 备份
            {catalog.data.status.zip_fresh ? "已同步" : "需更新"}
          </Typography.Paragraph>
          <Space wrap>
            <Input
              aria-label="筛选归档轨迹"
              placeholder="搜索日期、名称或标签"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            <Select
              virtual={false}
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
            size="small"
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
                      danger
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
export function FileWorkPage({
  group,
  fixedOperation,
  entry,
}: {
  group: "archive" | "tracks";
  fixedOperation?: Operation;
  entry?: string;
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
      fixedOperation ?? (group === "archive" ? "archive:status" : "kml:type"),
    ),
    [inputs, setInputs] = useState(""),
    [output, setOutput] = useState(""),
    [options, setOptions] = useState<Record<string, unknown>>(
      entry ? { name: entry } : {},
    ),
    [special, setSpecial] = useState<Record<string, string>>({}),
    [error, setError] = useState<unknown>(),
    [busy, setBusy] = useState(false),
    [params, setParams] = useSearchParams();
  const archivePath = workspace.archive || bootstrap.data?.archive || "";
  const [id, setId] = useState<string | null>(() =>
    !fixedOperation && params.get("panel") === group
      ? params.get("task")
      : null,
  );
  useEffect(() => {
    if (fixedOperation || params.get("panel") !== group) return;
    const requested = params.get("task");
    if (requested) setId(requested);
    else if (id) setParams({ panel: group, task: id }, { replace: true });
  }, [params, group, id, setParams, fixedOperation]);
  const [usingSelection, setUsingSelection] = useState(false);
  const [copying, setCopying] = useState(false);
  const setTask = (next: string) => {
    setId(next);
    if (!fixedOperation) setParams({ panel: group, task: next });
  };
  async function useSelection() {
    setCopying(true);
    setError(undefined);
    try {
      const batch = await api<UploadResult>("/api/work/selection-copy", {
        archive: workspace.archive,
        tracks: workspace.selected.map(({ entry, sha256 }) => ({
          entry,
          sha256,
        })),
      });
      setInputs(batch.files.join("\n"));
      setUsingSelection(true);
    } catch (e) {
      setError(e);
    } finally {
      setCopying(false);
    }
  }
  const names = Object.entries(OPERATIONS).filter(
    ([key]) =>
      key.startsWith(group === "tracks" ? "kml:" : "archive:") &&
      !["archive:init", "archive:import-zip"].includes(key),
  );
  const choose = (next: Operation) => {
    setOperation(next);
    setOutput("");
    setOptions({});
    setSpecial({});
  };
  function update(key: string, value: unknown) {
    setOptions((old) => ({ ...old, [key]: value }));
  }
  async function preview() {
    setBusy(true);
    setError(undefined);
    try {
      const opts = { ...options };
      for (const key of ["points", "missingTags"])
        if (special[key])
          opts[key] = special[key]!.split("\n")
            .map((v) => v.trim())
            .filter(Boolean);
      if (special.tags) {
        const tags: Record<string, string> = {};
        for (const line of special.tags.split("\n").filter(Boolean)) {
          const at = line.indexOf("=");
          if (at < 1) throw new Error("标签格式应为 NAME=VALUE，每行一个");
          tags[line.slice(0, at)] = line.slice(at + 1);
        }
        opts.tags = tags;
      }
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
        options: opts,
      });
      const task = await api<WorkTask>("/api/work/preview", body);
      setTask(task.id);
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="work-main">
        {!fixedOperation && (
          <Typography.Title level={1}>
            {group === "archive" ? "轨迹库管理" : "轨迹处理"}
          </Typography.Title>
        )}
        <Typography.Paragraph type="secondary">
          选择对象和参数，先查看预览，再确认执行。任务保存在服务端，关闭页面后仍可继续查看。
        </Typography.Paragraph>
        <ErrorBox error={bootstrap.error} />
        {!bootstrap.data ? (
          <Spin />
        ) : (
          <>
            {group === "tracks" && (
              <Card size="small" title="处理对象">
                <p>
                  {workspace.selected.length
                    ? `地图上已选择 ${workspace.selected.length} 条轨迹`
                    : "在轨迹库选择轨迹，或在下方上传 KML 文件。"}
                </p>
                <Button
                  disabled={!workspace.selected.length}
                  loading={copying}
                  onClick={() => void useSelection()}
                >
                  使用地图已选轨迹
                </Button>
                {usingSelection && (
                  <Alert
                    type="info"
                    title="正在处理轨迹副本"
                    description="库中原件保留不变。结果可下载并在主地图检查；需要保存到轨迹库时，请通过轨迹库的上传按钮入库。"
                  />
                )}
              </Card>
            )}
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
                        virtual={false}
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
                        placeholder={
                          operation === "kml:merge"
                            ? "完整输出 KML 文件路径"
                            : "留空使用源目录或归档目录"
                        }
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
                            onChange={(e) => update(key, e.target.checked)}
                          >
                            {booleanFields[key]}
                          </Checkbox>
                        ) : (
                          <div key={key}>
                            <label
                              className="work-label"
                              htmlFor={"option-" + key}
                            >
                              {textFields[key] ??
                                numberFields[key] ??
                                (
                                  {
                                    category: "轨迹分类",
                                    policy: "已有时区的处理方式",
                                    tags: "自定义标签（每行 NAME=VALUE）",
                                    points: "处理点（每行一个时间或坐标）",
                                    missingTags: "需要检查的标签（每行一个）",
                                  } as Record<string, string>
                                )[key]}
                            </label>
                            {key === "category" ? (
                              <Select
                                virtual={false}
                                id={"option-" + key}
                                allowClear
                                value={options[key] as string | undefined}
                                onChange={(v) => update(key, v)}
                                options={["Default", "Train", "Flight"].map(
                                  (v) => ({ value: v, label: v }),
                                )}
                              />
                            ) : key === "policy" ? (
                              <Select
                                virtual={false}
                                id={"option-" + key}
                                value={(options[key] as string) || "auto"}
                                onChange={(v) => update(key, v)}
                                options={[
                                  {
                                    value: "auto",
                                    label: "自动检查，有时区则等待决定",
                                  },
                                  { value: "keep", label: "保留已有时间点" },
                                  {
                                    value: "force",
                                    label: "按指定时区重新解释",
                                  },
                                ]}
                              />
                            ) : ["tags", "points", "missingTags"].includes(
                                key,
                              ) ? (
                              <Input.TextArea
                                id={"option-" + key}
                                value={special[key] ?? ""}
                                onChange={(e) =>
                                  setSpecial((v) => ({
                                    ...v,
                                    [key]: e.target.value,
                                  }))
                                }
                                rows={3}
                              />
                            ) : numberFields[key] ? (
                              <InputNumber
                                id={"option-" + key}
                                value={options[key] as number | undefined}
                                onChange={(v) => update(key, v ?? undefined)}
                              />
                            ) : key === "tag" ? (
                              <Select
                                virtual={false}
                                id={"option-" + key}
                                showSearch
                                value={options[key] as string | undefined}
                                onChange={(v) => update(key, v)}
                                options={["Default", "Train", "Flight"].flatMap(
                                  (c) =>
                                    (
                                      bootstrap.data!.config[
                                        ("track_tag." + c) as keyof PublicConfig
                                      ] as string[]
                                    ).map((v) => ({ label: v, value: v })),
                                )}
                              />
                            ) : (
                              <Input
                                id={"option-" + key}
                                value={(options[key] as string) ?? ""}
                                onChange={(e) =>
                                  update(key, e.target.value || undefined)
                                }
                                placeholder={
                                  key === "offset"
                                    ? "+08:00"
                                    : key === "language"
                                      ? "en"
                                      : undefined
                                }
                              />
                            )}
                          </div>
                        ),
                      )}
                  </div>
                  <ErrorBox error={error} />
                  <Button
                    type="primary"
                    className="work-actions"
                    loading={busy}
                    onClick={() => void preview()}
                  >
                    {READ_OPERATIONS.includes(operation)
                      ? "开始检查"
                      : "生成操作预览"}
                  </Button>
                </Card>
                {(group !== "archive" ||
                  ["archive:push", "archive:import-zip"].includes(
                    operation,
                  )) && (
                  <FilePicker
                    roots={bootstrap.data.roots}
                    value={inputs}
                    onChange={(value) => {
                      setInputs(value);
                      setUsingSelection(false);
                    }}
                  />
                )}
              </section>
              <section>
                {id ? (
                  <TaskDetail id={id} onSelect={setTask} />
                ) : (
                  <Card title="预览与结果">
                    <Typography.Paragraph type="secondary">
                      尚未提交操作。预览会列出处理对象、预计输出和发现的问题。
                    </Typography.Paragraph>
                    <Button onClick={() => workspace.open("tasks")}>
                      查看处理记录
                    </Button>
                  </Card>
                )}
              </section>
            </div>
            {group === "archive" && !fixedOperation && archivePath && (
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
function UploadsPanel() {
  const [error, setError] = useState<unknown>();
  const query = useQuery({
    queryKey: ["uploads"],
    queryFn: ({ signal }) =>
      api<{ uploads: UploadResult[] }>("/api/work/uploads", undefined, signal),
  });
  return (
    <Card
      title="暂存文件"
      extra={<Button onClick={() => void query.refetch()}>刷新暂存</Button>}
    >
      <Typography.Paragraph type="secondary">
        上传文件保留 7
        天；服务启动时清理过期且未被运行中任务使用的批次。手动清理后，该批次的旧结果将无法下载。
      </Typography.Paragraph>
      <ErrorBox error={error ?? query.error} />
      {query.data?.uploads.map((batch) => (
        <div className="work-result" key={batch.id}>
          <span className="wrap-path">
            {batch.files.map((file) => file.split(/[\\/]/).at(-1)).join("、") ||
              "空批次"}{" "}
            · {(batch.bytes / 1024 / 1024).toFixed(1)} MiB
          </span>
          <Button
            danger
            onClick={() => {
              void api("/api/work/uploads/" + batch.id + "/cleanup", {})
                .then(() => query.refetch())
                .catch(setError);
            }}
          >
            清理暂存
          </Button>
        </div>
      ))}
    </Card>
  );
}
export function TasksPage() {
  const [params, setParams] = useSearchParams(),
    id = params.get("id");
  const tasks = useQuery({
    queryKey: ["tasks"],
    queryFn: ({ signal }) =>
      api<{ tasks: WorkTask[] }>("/api/work/tasks", undefined, signal),
    refetchInterval: 1000,
  });
  return (
    <>
      <div className="work-main">
        <Typography.Title level={1}>处理记录</Typography.Title>
        <Typography.Paragraph type="secondary">
          任务保存在服务端。中断或部分失败后，重新预览当前文件再重试；不会自动重复写入。
        </Typography.Paragraph>
        <ErrorBox error={tasks.error} />
        <Table
          rowKey="id"
          dataSource={
            tasks.data?.tasks.filter(
              (task) => !task.request.operation.startsWith("exif:"),
            ) ?? []
          }
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "操作",
              render: (_, task) => (
                <Button
                  type="link"
                  onClick={() => setParams({ panel: "tasks", id: task.id })}
                >
                  {task.mode === "plan" ? "预览" : "执行"} ·{" "}
                  {operationLabel(task.request.operation)}
                </Button>
              ),
            },
            { title: "状态", render: (_, task) => statusLabel[task.status] },
            {
              title: "创建时间",
              render: (_, task) => new Date(task.createdAt).toLocaleString(),
            },
          ]}
        />
        {id && (
          <TaskDetail
            id={id}
            onSelect={(next) => setParams({ panel: "tasks", id: next })}
          />
        )}
        <UploadsPanel />
      </div>
    </>
  );
}
