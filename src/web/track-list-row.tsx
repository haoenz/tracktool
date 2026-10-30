import type { OverviewEntry } from "../shared/overview.js";
import { Button, Checkbox } from "./components/controls.js";
import { VisibilityIcon } from "./components/visibility-icon.js";

/** One library row: name, distance, batch checkbox or visibility toggle. */
export function TrackListRow({
  entry,
  selected,
  visible,
  batchMode,
  batchSelecting,
  checked,
  onOpen,
  onToggleBatch,
  onToggleVisible,
}: {
  entry: OverviewEntry;
  selected: boolean;
  visible: boolean;
  batchMode: boolean;
  batchSelecting: boolean;
  checked: boolean;
  onOpen: () => void;
  onToggleBatch: () => void;
  onToggleVisible: () => void;
}) {
  return (
    <div
      className={`overview-row${(batchMode ? checked : selected) ? " selected" : ""}`}
    >
      <button
        className="track-row-name"
        aria-label={`${batchMode ? "选择" : "查看"} ${entry.entry}`}
        disabled={batchMode && batchSelecting}
        aria-pressed={batchMode ? checked : selected}
        onClick={() => (batchMode ? onToggleBatch() : onOpen())}
      >
        <strong title={entry.name.replace(/\.kml$/i, "")}>
          {entry.name.replace(/\.kml$/i, "")}
        </strong>
        {entry.distance_m !== undefined && (
          <span className="track-distance">
            {(entry.distance_m / 1000).toFixed(1)} km
          </span>
        )}
      </button>
      {batchMode ? (
        <Checkbox
          aria-label={`选择 ${entry.name}`}
          checked={checked}
          disabled={batchSelecting}
          onCheckedChange={onToggleBatch}
        />
      ) : (
        <Button
          className="track-row-visibility"
          variant="ghost"
          aria-label={`${visible ? "隐藏" : "显示"} ${entry.name}`}
          aria-pressed={visible}
          onClick={onToggleVisible}
        >
          <VisibilityIcon visible={visible} />
        </Button>
      )}
      {entry.error && <span className="map-error">{entry.error}</span>}
    </div>
  );
}
