import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import type { WorkTask } from "../shared/work.js";
import {
  downloadWorkFile,
  downloadWorkFiles,
  requestWorkTask,
  waitForWorkTask,
} from "./api.js";
import { Alert, Button } from "./components/controls.js";
import { LoadingFeedback } from "./components/loading-feedback.js";
import { ExportOptions, ExportResult } from "./export-panel.js";
import { ImportPanel } from "./import-panel.js";
import { useWorkspace } from "./workspace.js";
import "./work.css";

export type ArchiveAction =
  "archive:push" | "archive:backup" | "archive:rebuild";

function ExportTask({
  initial,
  processing,
  onDownloaded,
}: {
  initial: WorkTask;
  processing: boolean;
  onDownloaded: () => void;
}) {
  const id = initial.id;
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const query = useQuery<WorkTask>({
    queryKey: ["task", id],
    initialData: initial,
    queryFn: ({ signal }) =>
      requestWorkTask(`/api/work/tasks/${id}`, undefined, signal),
    refetchInterval: (q) =>
      q.state.data && !["queued", "running"].includes(q.state.data.status)
        ? false
        : 1000,
  });
  const task = query.data;
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
      await query.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  const message = query.error?.message || error;
  if (!task)
    return (
      <>
        {message ? (
          <Alert type="error" title={message} />
        ) : (
          <LoadingFeedback active label="正在读取导出进度…" />
        )}
        {message && (
          <Button onClick={() => void query.refetch()}>重试读取进度</Button>
        )}
      </>
    );
  return (
    <ExportResult
      task={task}
      busy={busy}
      processing={processing}
      onCancel={() =>
        void run(() =>
          requestWorkTask(`/api/work/tasks/${id}/cancel`, {
            revision: task.revision,
          }),
        )
      }
      onDownload={(index, name) =>
        void run(async () => {
          await downloadWorkFile(task, index, name);
          onDownloaded();
        })
      }
      onRefresh={() => void query.refetch()}
    >
      {message && (
        <>
          <Alert type="error" title={message} />
          <Button onClick={() => void query.refetch()}>重试读取进度</Button>
        </>
      )}
    </ExportResult>
  );
}

export function ArchiveWorkPage({
  fixedOperation,
  entries,
}: {
  fixedOperation: ArchiveAction;
  entries?: string[];
}) {
  if (fixedOperation === "archive:push") return <ImportPanel />;
  return <ArchiveExport operation={fixedOperation} entries={entries} />;
}

function ArchiveExport({
  operation,
  entries,
}: {
  operation: "archive:backup" | "archive:rebuild";
  entries?: string[];
}) {
  const { archive } = useWorkspace();
  const [options, setOptions] = useState<Record<string, unknown>>(
    operation === "archive:backup"
      ? { format: "zip-deflate", compression: "extreme" }
      : {},
  );
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [task, setTask] = useState<WorkTask>();
  async function exportTracks() {
    setBusy(true);
    setError("");
    setTask(undefined);
    try {
      const task = await requestWorkTask("/api/work/preview", {
        operation,
        archive,
        inputs: [],
        options: { ...options, ...(entries ? { entries } : {}) },
      });
      setTask(task);
      await waitForWorkTask(task.id);
      const applied = await requestWorkTask(
        `/api/work/tasks/${task.id}/apply`,
        {},
      );
      setTask(applied);
      await downloadWorkFiles(await waitForWorkTask(applied.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ExportOptions
        options={options}
        onOptionsChange={(value) => setOptions((old) => ({ ...old, ...value }))}
        zip={operation === "archive:backup"}
        busy={busy}
        disabled={!archive}
        onExport={() => void exportTracks()}
      >
        {error && <Alert type="error" title={error} />}
        {error && (
          <Button
            disabled={busy || !archive}
            onClick={() => void exportTracks()}
          >
            重试导出
          </Button>
        )}
      </ExportOptions>
      {!task && (
        <LoadingFeedback
          active={busy}
          label="正在准备导出…"
          hint="正在确认导出范围，请检查网络连接；请求仍在进行中。"
        />
      )}
      {task && (
        <ExportTask
          key={task.id}
          initial={task}
          processing={busy}
          onDownloaded={() => setError("")}
        />
      )}
    </>
  );
}
