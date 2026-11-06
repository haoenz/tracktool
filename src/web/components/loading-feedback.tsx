import { useRef } from "react";
import { useLoadingFeedback } from "../loading-feedback.js";
import { Spin } from "./controls.js";

export function LoadingFeedback({
  active,
  label,
  task,
  hint = "等待时间较长，请检查网络连接；请求仍在进行中。",
  className = "loading-feedback",
}: {
  active: boolean;
  label: string;
  task?: string;
  hint?: string;
  className?: string;
}) {
  const { visible, slow } = useLoadingFeedback(active, task);
  const lastLabel = useRef(label);
  if (active) lastLabel.current = label;
  if (!visible) return null;
  return (
    <div className={className} role="status" aria-live="polite">
      <div className="loading-feedback-title">
        <Spin decorative /> <span>{active ? label : lastLabel.current}</span>
      </div>
      {slow && <p className="loading-feedback-hint">{hint}</p>}
    </div>
  );
}

export function SlowLoadingHint({
  active,
  task,
  children,
}: {
  active: boolean;
  task?: string;
  children: string;
}) {
  const { slow } = useLoadingFeedback(active, task);
  return slow ? (
    <p className="loading-feedback-hint" role="status">
      {children}
    </p>
  ) : null;
}

export function LoadingPlaceholder({
  label,
  active = true,
  variant = "list",
  hint = "等待时间较长，请检查网络连接；请求仍在进行中。",
}: {
  label: string;
  active?: boolean;
  variant?: "list" | "detail" | "route" | "chart";
  hint?: string;
}) {
  const { visible, slow } = useLoadingFeedback(active);
  return (
    <div
      className={`loading-placeholder loading-placeholder-${variant}`}
      aria-busy={active}
    >
      <div
        className="loading-placeholder-shapes"
        aria-hidden="true"
        style={{ visibility: visible ? "visible" : "hidden" }}
      >
        {Array.from({ length: variant === "route" ? 2 : 4 }, (_, index) => (
          <span className="track-value-skeleton" key={index} />
        ))}
      </div>
      {visible && (
        <span className="sr-only" role="status">
          {label}
        </span>
      )}
      {slow && <p className="loading-feedback-hint">{hint}</p>}
    </div>
  );
}
