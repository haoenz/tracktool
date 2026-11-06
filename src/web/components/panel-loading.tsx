import { LoadingFeedback } from "./loading-feedback.js";

export function PanelLoading({ children = "加载中…" }: { children?: string }) {
  return (
    <div className="panel-loading" aria-busy="true">
      <LoadingFeedback active label={children} />
    </div>
  );
}
