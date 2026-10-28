import { useRef, useState } from "react";
import { FileJson, FolderOpen, ImageDown, List, Trash2 } from "lucide-react";
import type { MapState } from "../shared/map-state.js";
import { frames, mapTitleError } from "../shared/map-state.js";
import type { StoredPrint } from "./print-store.js";
import {
  Button,
  Checkbox,
  Input,
  InputNumber,
  Modal,
  Select,
} from "./components/controls.js";
import "./print-panel.css";

const widthMin = (state: MapState) =>
  Math.max(256, Math.ceil((256 * state.frame.width) / state.frame.height));
const widthMax = (state: MapState) =>
  Math.min(4096, Math.floor((4096 * state.frame.width) / state.frame.height));

function stamp(time: number) {
  return new Date(time).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function PrintPanel({
  state,
  visibleCount,
  busy,
  exporting,
  error,
  drafts,
  guides,
  cameraLocked,
  onRatio,
  onWidth,
  onTitle,
  onExport,
  onExportJson,
  onImportJson,
  onRestore,
  onDelete,
  onOpenLibrary,
  onGuides,
  onCameraLocked,
  onFit,
}: {
  state: MapState;
  visibleCount: number;
  busy: boolean;
  exporting: boolean;
  error: string;
  drafts: StoredPrint[];
  guides: boolean;
  cameraLocked: boolean;
  onRatio: (ratio: MapState["frame"]["ratio"]) => void;
  onWidth: (width: number) => void;
  onTitle: (title: string) => void;
  onExport: () => void;
  onExportJson: () => void;
  onImportJson: (file: File) => void;
  onRestore: (draft: StoredPrint) => void;
  onDelete: (id: string) => void;
  onOpenLibrary: () => void;
  onGuides: (value: boolean) => void;
  onCameraLocked: (value: boolean) => void;
  onFit: () => void;
}) {
  const file = useRef<HTMLInputElement>(null);
  const [draftsOpen, setDraftsOpen] = useState(false);
  const titleError = mapTitleError(state.title);
  return (
    <section className="print-panel" aria-label="出图设置">
      <p className="print-panel-note">
        蒙版框内就是成图范围。地图上显示哪些轨迹，出图就是哪些轨迹。
      </p>
      <label htmlFor="print-ratio">画框比例</label>
      <Select
        id="print-ratio"
        aria-label="画框比例"
        value={state.frame.ratio}
        options={Object.keys(frames).map((value) => ({
          value,
          label:
            value === "1:1"
              ? "1:1 · 方图"
              : Number(value.split(":")[0]) > Number(value.split(":")[1])
                ? `${value} · 横版`
                : `${value} · 竖版`,
        }))}
        onChange={(ratio: MapState["frame"]["ratio"]) => onRatio(ratio)}
      />
      <label htmlFor="print-width">输出宽度</label>
      <InputNumber
        id="print-width"
        aria-label="输出宽度"
        value={state.output.width}
        min={widthMin(state)}
        max={widthMax(state)}
        precision={0}
        step={1}
        onChange={(value) => value !== null && onWidth(value)}
      />
      <p className="print-panel-hint">
        {state.output.width} × {state.output.height} px
      </p>
      <p className="print-panel-hint">
        当前显示 {visibleCount.toLocaleString()} 条轨迹
        <Button size="sm" variant="link" onClick={onOpenLibrary}>
          在轨迹库调整
        </Button>
      </p>
      <label htmlFor="print-title">标题</label>
      <Input
        id="print-title"
        aria-label="标题"
        value={state.title}
        maxLength={60}
        placeholder="留空不显示标题"
        aria-invalid={!!titleError}
        onChange={(event) => onTitle(event.target.value)}
      />
      {titleError ? (
        <p className="print-panel-error" role="alert">
          {titleError}
        </p>
      ) : (
        <p className="print-panel-hint">{[...state.title].length}/60 字</p>
      )}
      <Button
        variant="default"
        block
        loading={exporting}
        disabled={busy || !!titleError}
        onClick={onExport}
      >
        <ImageDown aria-hidden="true" />
        导出 PNG
      </Button>
      <div className="map-actions">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || exporting}
          onClick={() => file.current?.click()}
        >
          <FolderOpen aria-hidden="true" />
          导入 JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || exporting}
          onClick={onExportJson}
        >
          <FileJson aria-hidden="true" />
          导出 JSON
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || exporting}
          onClick={() => setDraftsOpen(true)}
        >
          <List aria-hidden="true" />
          草稿 {drafts.length}
        </Button>
      </div>
      <div className="print-panel-toggles">
        <Checkbox checked={cameraLocked} onCheckedChange={onCameraLocked}>
          锁定构图
        </Checkbox>
        <Checkbox checked={guides} onCheckedChange={onGuides}>
          显示辅助线
        </Checkbox>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onFit}>
          适配全部轨迹
        </Button>
      </div>
      {error && (
        <p className="print-panel-error" role="alert">
          {error}
        </p>
      )}
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={(event) => {
          const selected = event.target.files?.[0];
          event.target.value = "";
          if (selected) onImportJson(selected);
        }}
      />
      <Modal
        title="最近草稿"
        open={draftsOpen}
        onCancel={() => setDraftsOpen(false)}
        footer={<Button onClick={() => setDraftsOpen(false)}>关闭</Button>}
      >
        {drafts.length ? (
          <div className="print-drafts">
            {drafts.map((draft) => (
              <div className="print-draft" key={draft.id}>
                <div>
                  <strong>{draft.document.title || "未命名出图"}</strong>
                  <small>
                    {stamp(draft.updatedAt)} · {draft.document.tracks.length}{" "}
                    条轨迹 · {draft.document.output.width} ×{" "}
                    {draft.document.output.height}
                  </small>
                </div>
                <div className="print-draft-actions">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onRestore(draft);
                      setDraftsOpen(false);
                    }}
                  >
                    恢复
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label="删除草稿"
                    title="删除草稿"
                    onClick={() => onDelete(draft.id)}
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p>还没有草稿。调整构图或导出后会出现在这里。</p>
        )}
      </Modal>
    </section>
  );
}
