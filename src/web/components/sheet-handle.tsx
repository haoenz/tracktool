import { useRef, type PointerEvent, type RefObject } from "react";

const stops = ["collapsed", "half", "full"] as const;
const labels = ["收起", "半屏", "展开"];

/** The handle owns resizing; native scrolling remains on the panel content. */
export function SheetHandle({
  panel,
  value,
  onChange,
}: {
  panel: RefObject<HTMLElement | null>;
  value: string;
  onChange: (value: string) => void;
}) {
  const drag = useRef<{
    id: number;
    y: number;
    height: number;
    heights: number[];
    lastY: number;
    time: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  const suppressClick = useRef(false);
  const index = Math.max(
    0,
    stops.findIndex((stop) => stop === value),
  );
  const choose = (next: number) => {
    if (next === 0 && panel.current) panel.current.scrollTop = 0;
    onChange(stops[Math.max(0, Math.min(2, next))]!);
  };
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = drag.current;
    const element = panel.current;
    if (!current || current.id !== event.pointerId || !element) return;
    drag.current = null;
    suppressClick.current = current.moved;
    const height = element.getBoundingClientRect().height;
    element.style.removeProperty("height");
    delete element.dataset.dragging;
    if (!cancel && current.moved) {
      const velocity =
        event.timeStamp - current.time < 100 ? current.velocity : 0;
      const nearest = current.heights.reduce(
        (best, candidate, i) =>
          Math.abs(candidate - height) <
          Math.abs(current.heights[best]! - height)
            ? i
            : best,
        0,
      );
      choose(
        Math.abs(velocity) > 0.5 ? index + (velocity < 0 ? 1 : -1) : nearest,
      );
    }
  };
  return (
    <button
      type="button"
      className="sheet-handle"
      aria-label={`调整面板高度，当前${labels[index]}`}
      aria-describedby="sheet-handle-help"
      onPointerDown={(event) => {
        const element = panel.current;
        if (!element || !event.isPrimary || event.button !== 0) return;
        const max = parseFloat(getComputedStyle(element).maxHeight);
        const viewport = document.documentElement.clientHeight;
        drag.current = {
          id: event.pointerId,
          y: event.clientY,
          height: element.getBoundingClientRect().height,
          heights: [52, Math.min(viewport * 0.48, max), max],
          lastY: event.clientY,
          time: event.timeStamp,
          velocity: 0,
          moved: false,
        };
        suppressClick.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        const element = panel.current;
        if (!current || current.id !== event.pointerId || !element) return;
        const delta = event.clientY - current.y;
        current.moved ||= Math.abs(delta) > 5;
        const elapsed = event.timeStamp - current.time;
        if (elapsed > 0)
          current.velocity = (event.clientY - current.lastY) / elapsed;
        current.lastY = event.clientY;
        current.time = event.timeStamp;
        if (!current.moved) return;
        element.dataset.dragging = "true";
        element.style.height = `${Math.max(52, Math.min(current.heights[2]!, current.height - delta))}px`;
      }}
      onPointerUp={(event) => finish(event)}
      onPointerCancel={(event) => finish(event, true)}
      onLostPointerCapture={(event) => finish(event, true)}
      onClick={() => {
        if (suppressClick.current) {
          suppressClick.current = false;
          return;
        }
        choose((index + 1) % 3);
      }}
      onKeyDown={(event) => {
        const next = {
          ArrowUp: index + 1,
          ArrowDown: index - 1,
          Home: 0,
          End: 2,
        }[event.key];
        if (next === undefined) return;
        event.preventDefault();
        choose(next);
      }}
    >
      <span className="sheet-handle-bar" aria-hidden="true" />
      <span id="sheet-handle-help" className="sr-only">
        上下拖动调整高度，轻点切换；也可使用上下方向键。
      </span>
    </button>
  );
}
