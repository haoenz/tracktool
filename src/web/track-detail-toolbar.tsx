import { Download, Ellipsis, LocateFixed, Pencil, Trash2 } from "lucide-react";
import { Button } from "./components/controls.js";
import { VisibilityIcon } from "./components/visibility-icon.js";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "./components/ui/popover.js";
import { Popover as PopoverPrimitive } from "radix-ui";

/** Locate, visibility, edit, download and delete actions for the open track. */
export function TrackDetailToolbar({
  onLocate,
  locateDisabled,
  visible,
  onToggleVisible,
  visibilityDisabled,
  onEdit,
  downloading,
  downloadDisabled,
  onDownload,
  deleteDisabled,
  onDelete,
}: {
  onLocate: () => void;
  locateDisabled: boolean;
  visible: boolean;
  onToggleVisible: () => void;
  visibilityDisabled: boolean;
  onEdit: () => void;
  downloading: boolean;
  downloadDisabled: boolean;
  onDownload: () => void;
  deleteDisabled: boolean;
  onDelete: () => void;
}) {
  const visibilityLabel = visible ? "在地图上隐藏该轨迹" : "在地图上显示该轨迹";
  return (
    <div className="track-detail-toolbar">
      <Button
        variant="default"
        className="track-locate-primary"
        onClick={onLocate}
        disabled={locateDisabled}
      >
        <LocateFixed aria-hidden="true" />
        定位轨迹
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label={visibilityLabel}
        title={visibilityLabel}
        aria-pressed={visible}
        disabled={visibilityDisabled}
        onClick={onToggleVisible}
      >
        <VisibilityIcon visible={visible} />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="编辑轨迹"
        title="编辑轨迹"
        onClick={onEdit}
      >
        <Pencil aria-hidden="true" />
      </Button>
      <Button
        size="icon"
        variant="ghost"
        aria-label="下载轨迹"
        title="下载轨迹"
        loading={downloading}
        disabled={downloadDisabled}
        onClick={onDownload}
      >
        {!downloading && <Download aria-hidden="true" />}
      </Button>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label="更多轨迹操作"
            title="更多轨迹操作"
          >
            <Ellipsis aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-44 p-1">
          <PopoverPrimitive.Close asChild>
            <Button
              variant="ghost"
              className="w-full justify-start text-destructive"
              disabled={deleteDisabled}
              onClick={onDelete}
            >
              <Trash2 aria-hidden="true" />
              删除轨迹
            </Button>
          </PopoverPrimitive.Close>
        </PopoverContent>
      </Popover>
    </div>
  );
}
