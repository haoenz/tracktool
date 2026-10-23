import type { ReactNode } from "react";
import {
  Check,
  CircleAlert,
  Download,
  FileArchive,
  FileCode,
  LoaderCircle,
} from "lucide-react";
import { Button, Progress } from "./components/controls.js";
import type { WorkTask } from "../shared/work.js";

export function ExportOptions({
  zip,
  busy,
  disabled,
  onExport,
  children,
}: {
  zip: boolean;
  busy: boolean;
  disabled: boolean;
  onExport: () => void;
  children?: ReactNode;
}) {
  const Icon = zip ? FileArchive : FileCode;
  return (
    <div className="export-options">
      <div className="export-format-note">
        <Icon size={20} aria-hidden="true" />
        <div>
          <h3>{zip ? "展示 KML 打包" : "聚合导出"}</h3>
          <p>
            {zip
              ? "将轨迹分别保存为展示 KML，打包为一个 ZIP 文件。"
              : "将轨迹汇总为集合 KML，生成桌面和手机版本。"}
          </p>
          <p>使用轨迹当前的展示设置，不包含历史版本。</p>
        </div>
      </div>
      {children}
      <div className="export-actions">
        <Button
          block
          variant="default"
          loading={busy}
          disabled={disabled}
          onClick={onExport}
        >
          {!busy && <Download size={16} aria-hidden="true" />}
          {busy ? "正在导出…" : "导出"}
        </Button>
        <p className="export-hint">完成后自动下载，下载后清理临时文件。</p>
      </div>
    </div>
  );
}

export function ExportResult({
  task,
  busy,
  processing,
  onCancel,
  onDownload,
  onRefresh,
  children,
}: {
  task: WorkTask;
  busy: boolean;
  processing: boolean;
  onCancel: () => void;
  onDownload: (index: number, name: string) => void;
  onRefresh: () => void;
  children?: ReactNode;
}) {
  const active = ["queued", "running"].includes(task.status);
  const preparing =
    processing && task.mode === "plan" && task.status === "succeeded";
  const complete = task.mode === "apply" && task.status === "succeeded";
  const pending = active || preparing;
  const Icon = pending ? LoaderCircle : complete ? Check : CircleAlert;
  const allDownloaded =
    !!task.output?.paths.length &&
    task.output.paths.every((_, index) =>
      task.downloadedFiles?.includes(index),
    );
  const title = pending
    ? task.mode === "plan"
      ? "正在准备导出…"
      : "正在生成文件…"
    : complete
      ? allDownloaded
        ? "下载完成"
        : "导出完成"
      : task.status === "cancelled"
        ? "导出已取消"
        : task.status === "partial"
          ? "部分导出失败"
          : task.status === "interrupted"
            ? "导出已中断"
            : "导出失败";
  const files = task.mode === "apply" && !active ? task.output?.paths : [];
  return (
    <section className="export-result task-detail" aria-label="导出结果">
      <div className="export-result-heading" role="status">
        <Icon
          size={18}
          className={pending ? "animate-spin" : undefined}
          aria-hidden="true"
        />
        <h3>{title}</h3>
      </div>
      {active && task.progress.total > 0 && (
        <Progress
          percent={Math.round(
            (task.progress.completed / task.progress.total) * 100,
          )}
          status="active"
          format={() => `${task.progress.completed} / ${task.progress.total}`}
        />
      )}
      {children}
      {files?.map((file, index) => {
        const name = file.split(/[\\/]/).at(-1)!;
        return (
          <div className="export-file" key={file}>
            <span>{name}</span>
            {task.downloadedFiles?.includes(index) ? (
              <span className="export-hint">已下载</span>
            ) : !task.exportsCleaned ? (
              <Button
                size="sm"
                disabled={processing || busy}
                onClick={() => onDownload(index, name)}
              >
                <Download size={14} aria-hidden="true" />
                下载
              </Button>
            ) : (
              <span className="export-hint">已清理</span>
            )}
          </div>
        );
      })}
      {task.exportsCleaned && (
        <p className="export-hint">临时文件已清理，需要时请重新导出。</p>
      )}
      {active && (
        <Button size="sm" loading={busy} onClick={onCancel}>
          取消导出
        </Button>
      )}
      <details className="export-details">
        <summary>查看执行详情</summary>
        <p className="export-hint">
          {new Date(task.createdAt).toLocaleString()}
        </p>
        {task.output?.data !== undefined && (
          <pre className="work-output">
            {typeof task.output.data === "string"
              ? task.output.data
              : JSON.stringify(task.output.data, null, 2)}
          </pre>
        )}
        {task.result && (
          <pre className="work-output">
            {JSON.stringify(task.result, null, 2)}
          </pre>
        )}
        <div className="work-log">
          {task.events
            .filter((event) => event.event.type === "log")
            .map(({ sequence, event }) => (
              <div key={sequence}>
                {event.type === "log" ? event.message : ""}
              </div>
            ))}
        </div>
        <Button size="sm" onClick={onRefresh}>
          刷新状态
        </Button>
      </details>
    </section>
  );
}
