import { ChevronRight, History, SlidersHorizontal } from "lucide-react";
import { Button } from "./components/controls.js";

export type DetailView = "display" | "history";

/** Secondary entries (display settings, history) under the detail toolbar. */
export function TrackDetailLinks({
  views,
  titles,
  onSelect,
}: {
  views: DetailView[];
  titles: Record<DetailView, string>;
  onSelect: (view: DetailView) => void;
}) {
  if (!views.length) return null;
  return (
    <div className="track-detail-links">
      {views.map((view) => (
        <Button
          key={view}
          variant="ghost"
          className="track-detail-link"
          aria-label={titles[view]}
          onClick={() => onSelect(view)}
        >
          {view === "display" ? (
            <SlidersHorizontal aria-hidden="true" />
          ) : (
            <History aria-hidden="true" />
          )}
          <span>
            <strong>{titles[view]}</strong>
          </span>
          <ChevronRight aria-hidden="true" />
        </Button>
      ))}
    </div>
  );
}
