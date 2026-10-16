import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Alert, Button, Modal, Space, Spin } from "./components/controls.js";
import { api, request, waitForWorkTask } from "./api.js";
import { TrackEditorMap } from "./track-editor-map.js";
import { useWorkspace } from "./workspace.js";
import type {
  EditGeometry,
  EditPreview,
  EditRequest,
  EntrySnapshot,
  HistoryEvent,
  TrackDetail,
  VersionRef,
} from "../shared/track-edit.js";

const ref = (e: VersionRef): VersionRef => ({
  entry_id: e.entry_id,
  version_id: e.version_id,
  presentation_id: e.presentation_id,
  generation: e.generation,
  sha256: e.sha256,
});
const time = (s: string) => new Date(s).toLocaleString();
export function TrackHistory({
  entryId,
  active,
}: {
  entryId: string;
  active: boolean;
}) {
  const workspace = useWorkspace(),
    cache = useQueryClient();
  const [cursor, setCursor] = useState(0),
    [selected, setSelected] = useState<HistoryEvent>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [confirmation, setConfirmation] = useState<{
      event: HistoryEvent;
      undo: boolean;
    }>(),
    [prepared, setPrepared] = useState<EditPreview>(),
    [confirmError, setConfirmError] = useState("");
  const history = useQuery({
    queryKey: ["track-history", entryId, "timeline", cursor],
    queryFn: () =>
      api<{ events: HistoryEvent[]; next_cursor: number | null }>(
        `/api/tracks/${entryId}/history?cursor=${cursor}`,
      ),
  });
  const geometry = useQuery({
    queryKey: [
      "history-geometry",
      entryId,
      selected?.after.version_id,
      selected?.after.presentation_id,
    ],
    queryFn: () =>
      api<EditGeometry>(
        `/api/tracks/${entryId}/geometry?${new URLSearchParams({ version_id: selected!.after.version_id, presentation_id: selected!.after.presentation_id })}`,
      ),
    enabled: !!selected && active,
  });
  async function download() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await request(
        `/api/tracks/${entryId}/versions/${selected.after.version_id}/raw`,
      );
      const url = URL.createObjectURL(await response.blob()),
        a = document.createElement("a");
      a.href = url;
      a.download = selected.after.path.split("/").at(-1) ?? "track.kml";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function prepare(event: HistoryEvent, undo: boolean) {
    setConfirmation({ event, undo });
    setPrepared(undefined);
    setConfirmError("");
    setBusy(true);
    try {
      const current = await api<TrackDetail>(`/api/tracks/${entryId}`);
      let body: EditRequest;
      if (undo) {
        const op = await api<{
          effects: { after: EntrySnapshot }[];
          deleted: boolean;
        }>(`/api/tracks/operations/${event.id}`);
        if (op.deleted)
          throw new Error("拆分产生的行程已被删除，无法撤销拆分。");
        body = {
          schema: 1,
          archive_id: current.archive_id,
          operation: {
            kind: "restore_group",
            operation_id: event.id,
            expected: op.effects.map((e) => ref(e.after)),
          },
        };
      } else
        body = {
          schema: 1,
          archive_id: current.archive_id,
          target: ref(current.entry),
          sources: [],
          operation: {
            kind: "restore_version",
            version_id: event.after.version_id,
            presentation_id: event.after.presentation_id,
          },
        };
      const task = await api<{ task_id: string }>(
        "/api/tracks/edit-previews",
        body,
      );
      const ready = await waitForWorkTask(task.task_id);
      setPrepared(ready.output!.data as EditPreview);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function apply() {
    if (!prepared) return;
    setBusy(true);
    setConfirmError("");
    try {
      const task = await api<{ task_id: string }>(
        `/api/tracks/edit-previews/${prepared.preview_id}/apply`,
        {
          schema: 1,
          archive_id: prepared.archive_id,
          preview_id: prepared.preview_id,
          preview_sha256: prepared.preview_sha256,
          request_key: `apply:${prepared.preview_id}`,
        },
      );
      await waitForWorkTask(task.task_id);
      setConfirmation(undefined);
      setPrepared(undefined);
      setSelected(undefined);
      setCursor(0);
      setNotice("已恢复，恢复前的状态仍保留在历史中。");
      await cache.invalidateQueries({ queryKey: ["track-history"] });
      await cache.invalidateQueries({ queryKey: ["track-detail"] });
      await workspace.refresh(workspace.archive);
    } catch (e) {
      setConfirmError(e instanceof Error ? e.message : String(e));
      setPrepared(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="work-main track-history">
      <p>点击记录查看当时的轨迹，不会修改当前轨迹。</p>
      {(error || history.error) && (
        <Alert type="error" title={error || history.error!.message} />
      )}
      {notice && (
        <Alert
          type="info"
          title={notice}
          closable
          onClose={() => setNotice("")}
        />
      )}
      {selected && (
        <section className="space-y-3" aria-label="历史状态">
          <p>
            <strong>
              {selected.current ? "正在查看当前状态" : "正在查看历史状态"}
            </strong>{" "}
            · {time(selected.created_at)} · {selected.title}
          </p>
          <Space wrap>
            <Button onClick={() => setSelected(undefined)}>回到当前</Button>
            <Button disabled={busy} onClick={() => void download()}>
              下载此时的 KML
            </Button>
            {!selected.current && selected.kind !== "split_journey" && (
              <Button
                disabled={busy}
                onClick={() => void prepare(selected, false)}
              >
                恢复到此状态
              </Button>
            )}
            {selected.kind === "split_journey" && (
              <Button
                disabled={busy}
                onClick={() => void prepare(selected, true)}
              >
                撤销拆分
              </Button>
            )}
          </Space>
          <p className="text-sm text-muted-foreground">
            地图包含当时的显示设置；KML 下载保留完整轨迹数据。
          </p>
          {geometry.isFetching && <Spin />}
          {geometry.error && (
            <Alert type="error" title={geometry.error.message} />
          )}
          {geometry.data && (
            <TrackEditorMap
              key={selected.id}
              geometry={geometry.data}
              active={active}
              autoFit
              readOnly
            />
          )}
        </section>
      )}
      {history.isFetching && <Spin />}
      {history.data && !history.data.events.length && <p>暂无历史操作。</p>}
      <ol className="space-y-2" aria-label="操作时间线">
        {history.data?.events.map((event) => (
          <li key={event.id}>
            <Button
              className="h-auto w-full justify-start whitespace-normal text-left"
              aria-pressed={selected?.id === event.id}
              onClick={() => {
                setSelected(event);
                setError("");
              }}
            >
              <span>
                <strong>{event.title}</strong>
                {event.current && " · 当前状态"}
                <br />
                <span className="text-sm text-muted-foreground">
                  {time(event.created_at)}
                </span>
              </span>
            </Button>
          </li>
        ))}
      </ol>
      {(cursor > 0 || history.data?.next_cursor != null) && (
        <Space>
          <Button
            disabled={!cursor || history.isFetching}
            onClick={() => setCursor(Math.max(0, cursor - 50))}
          >
            较新记录
          </Button>
          <Button
            disabled={history.data?.next_cursor == null || history.isFetching}
            onClick={() => setCursor(history.data!.next_cursor!)}
          >
            较早记录
          </Button>
        </Space>
      )}
      <Modal
        title={confirmation?.undo ? "撤销拆分" : "恢复历史状态"}
        open={!!confirmation}
        closable={!busy}
        maskClosable={!busy}
        onCancel={() => setConfirmation(undefined)}
        footer={
          <>
            <Button disabled={busy} onClick={() => setConfirmation(undefined)}>
              取消
            </Button>
            <Button
              variant="default"
              loading={busy}
              disabled={!prepared || busy}
              onClick={() => void apply()}
            >
              {confirmation?.undo ? "确认撤销拆分" : "确认恢复"}
            </Button>
          </>
        }
      >
        <p>
          {confirmation?.undo
            ? "将恢复拆分前的行程，拆分产生的行程会从轨迹列表移除。"
            : `将轨迹及显示设置恢复到 ${confirmation ? time(confirmation.event.created_at) : ""} 的状态。`}
        </p>
        <p>恢复前的状态仍保留在历史中。</p>
        {busy && !prepared && <p role="status">正在检查影响范围…</p>}
        {prepared && confirmation?.undo && (
          <ul>
            {prepared.outputs.map((o, i) => (
              <li key={i}>
                {o.state === "active" ? "恢复" : "移出轨迹列表"}：{o.path}
              </li>
            ))}
          </ul>
        )}
        {confirmation?.undo && prepared && (
          <p>已检查：关联行程没有阻止撤销的后续修改。</p>
        )}
        {confirmError && <Alert type="error" title={confirmError} />}
      </Modal>
    </div>
  );
}
