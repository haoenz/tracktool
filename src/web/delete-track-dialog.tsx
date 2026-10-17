import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Alert, Button } from "./components/controls.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "./components/ui/dialog.js";
import { api, waitForWorkTask } from "./api.js";
import { useWorkspace } from "./workspace.js";
import type { WorkTask } from "../shared/work.js";
import type { DeletePreview } from "../shared/archive-actions.js";

export function DeleteTrackDialog({
  entry,
  onClose,
  onDeleted,
  onViewProject,
}: {
  entry: string;
  onClose: () => void;
  onDeleted: () => void;
  onViewProject: (name: string) => void;
}) {
  const workspace = useWorkspace();
  const cache = useQueryClient();
  const cancel = useRef<HTMLButtonElement>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const [attempt, setAttempt] = useState(0);
  const preview = useQuery({
    queryKey: ["delete-track-preview", workspace.archive, entry, attempt],
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async () => {
      const task = await api<WorkTask>("/api/work/preview", {
        operation: "archive:delete",
        archive: workspace.archive,
        inputs: [],
        options: { name: entry },
      });
      const plan = await waitForWorkTask(task.id);
      const deletion = (
        plan.output?.data as { deletion_preview?: DeletePreview } | undefined
      )?.deletion_preview;
      if (!deletion) throw new Error("无法检查删除范围，请重试。");
      return { task: plan, deletion };
    },
  });
  const deletion = preview.data?.deletion;
  async function remove() {
    if (!preview.data || deletion?.dependencies.length || submitting.current)
      return;
    submitting.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const task = await api<WorkTask>(
        `/api/work/tasks/${preview.data.task.id}/apply`,
        {},
      );
      await waitForWorkTask(task.id);
    } catch (e) {
      setError(e);
      setAttempt((value) => value + 1);
      submitting.current = false;
      setBusy(false);
      return;
    }
    // Refresh failures must not invite a second deletion after a successful apply.
    onDeleted();
    toast.success("轨迹已删除");
    try {
      await workspace.refresh(workspace.archive);
      await Promise.all(
        ["work-catalog", "overview", "overview-entries"].map((key) =>
          cache.invalidateQueries({ queryKey: [key] }),
        ),
      );
    } catch {
      toast.error("轨迹已删除，但刷新失败，请刷新页面。");
    }
  }
  const failure = error ?? preview.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent
        aria-describedby={undefined}
        showCloseButton={!busy}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          cancel.current?.focus();
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          document
            .querySelector<HTMLButtonElement>(
              'button[aria-label="更多轨迹操作"]',
            )
            ?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (busy) event.preventDefault();
        }}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>删除「{entry.split("/").at(-1)}」？</DialogTitle>
        </DialogHeader>
        {preview.isPending && <p role="status">正在检查关联内容…</p>}
        {deletion && (
          <p className="text-sm">
            将永久删除这条轨迹及其 {deletion.versions} 个历史版本。
          </p>
        )}
        {!!deletion?.dependencies.length && (
          <Alert
            type="warning"
            title="暂时无法删除"
            description={
              <div>
                {deletion.dependencies.map((dependency) => (
                  <p key={dependency.kind + dependency.id}>
                    {dependency.kind === "project"
                      ? "项目"
                      : dependency.kind === "trajectory"
                        ? "轨迹"
                        : "待恢复操作"}
                    ：
                    {dependency.kind === "project"
                      ? dependency.id
                      : dependency.kind === "trajectory"
                        ? dependency.detail
                        : dependency.id}
                    。
                    {dependency.kind === "pending"
                      ? "请先完成轨迹库恢复。"
                      : "请先解除关联。"}
                    {dependency.kind === "project" && (
                      <Button
                        variant="link"
                        onClick={() => onViewProject(dependency.id)}
                      >
                        查看项目
                      </Button>
                    )}
                    {dependency.kind === "trajectory" &&
                      workspace.showTrack && (
                        <Button
                          variant="link"
                          onClick={() => {
                            onClose();
                            workspace.showTrack?.(dependency.id);
                          }}
                        >
                          查看轨迹
                        </Button>
                      )}
                  </p>
                ))}
              </div>
            }
          />
        )}
        {!!failure && (
          <Alert
            type="error"
            title={failure instanceof Error ? failure.message : String(failure)}
          />
        )}
        <DialogFooter>
          <Button ref={cancel} disabled={busy} onClick={onClose}>
            取消
          </Button>
          {preview.isError && (
            <Button
              onClick={() => {
                setError(undefined);
                setAttempt((value) => value + 1);
              }}
            >
              重新检查
            </Button>
          )}
          <Button
            variant="destructive"
            loading={busy}
            disabled={
              busy ||
              preview.isFetching ||
              !deletion ||
              !!deletion.dependencies.length
            }
            onClick={() => void remove()}
          >
            {busy ? "正在删除…" : "删除"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
