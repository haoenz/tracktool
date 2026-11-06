import {
  createContext,
  useEffect,
  useRef,
  type ComponentProps,
  type PointerEvent,
  type RefObject,
} from "react";

const stops = ["closed", "half", "full"] as const;
const labels = ["关闭", "半屏", "展开"];

type DragEvents = Pick<
  ComponentProps<"header">,
  | "onPointerDown"
  | "onPointerMove"
  | "onPointerUp"
  | "onPointerCancel"
  | "onLostPointerCapture"
  | "onClickCapture"
>;

export const SheetContext = createContext<{
  events: DragEvents;
} | null>(null);

/** Only the handle and header resize the sheet; content keeps native scrolling. */
export function SheetPanel({
  panel,
  activePanel,
  value,
  onChange,
  onClose,
  children,
  ...props
}: Omit<ComponentProps<"aside">, "ref" | "onChange"> & {
  panel: RefObject<HTMLElement | null>;
  activePanel: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onClose: () => void;
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
  const closing = useRef<Animation | null>(null);
  const suppressClick = useRef(false);
  const index = Math.max(
    1,
    stops.findIndex((stop) => stop === value),
  );
  useEffect(() => {
    // A tool switch must not let an old exit animation close the new panel.
    return () => {
      closing.current?.cancel();
      closing.current = null;
      drag.current = null;
      panel.current?.style.removeProperty("height");
      if (panel.current) delete panel.current.dataset.dragging;
    };
  }, [activePanel, panel]);
  const close = () => {
    const element = panel.current;
    if (!element || closing.current) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onClose();
      return;
    }
    const animation = element.animate(
      [
        { transform: "translateY(0)" },
        {
          transform: `translateY(${window.innerHeight - element.getBoundingClientRect().top}px)`,
        },
      ],
      { duration: 180, easing: "ease-out", fill: "forwards" },
    );
    closing.current = animation;
    animation.onfinish = () => {
      onClose();
      animation.cancel();
      closing.current = null;
    };
  };
  const choose = (next: number) => {
    if (next <= 0) close();
    else onChange(stops[Math.min(2, next)]!);
  };
  const finish = (event: PointerEvent<HTMLElement>, cancel = false) => {
    const current = drag.current;
    const element = panel.current;
    if (!current || current.id !== event.pointerId || !element) return;
    drag.current = null;
    suppressClick.current = current.moved;
    const height = element.getBoundingClientRect().height;
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
      // A fling advances one stop; a deliberate slow drag can reach any stop.
      choose(
        Math.abs(velocity) > 0.5 ? index + (velocity < 0 ? 1 : -1) : nearest,
      );
    }
    if (!closing.current) {
      element.style.removeProperty("height");
      delete element.dataset.dragging;
    }
  };
  const events: DragEvents = {
    onPointerDown: (event) => {
      const element = panel.current;
      suppressClick.current = false;
      if (
        !element ||
        !event.isPrimary ||
        event.button !== 0 ||
        closing.current ||
        !matchMedia("(max-width: 700px)").matches
      )
        return;
      const interactive = (event.target as HTMLElement).closest(
        "button, a, input, select, textarea, [role='button']",
      );
      if (interactive && interactive !== event.currentTarget) return;
      const max = parseFloat(getComputedStyle(element).maxHeight);
      const viewport = document.documentElement.clientHeight;
      drag.current = {
        id: event.pointerId,
        y: event.clientY,
        height: element.getBoundingClientRect().height,
        heights: [0, Math.min(viewport * 0.48, max), max],
        lastY: event.clientY,
        time: event.timeStamp,
        velocity: 0,
        moved: false,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event) => {
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
      element.style.height = `${Math.max(0, Math.min(current.heights[2]!, current.height - delta))}px`;
    },
    onPointerUp: (event) => finish(event),
    onPointerCancel: (event) => finish(event, true),
    onLostPointerCapture: (event) => finish(event, true),
    onClickCapture: (event) => {
      const suppress = suppressClick.current;
      suppressClick.current = false;
      if (suppress && event.detail > 0) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  return (
    <aside ref={panel} {...props}>
      <SheetContext value={{ events }}>
        <button
          type="button"
          className="sheet-handle"
          aria-label={`调整面板高度，当前${labels[index]}`}
          aria-describedby="sheet-handle-help"
          {...events}
          onClick={() => choose(index === 1 ? 2 : 1)}
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
            上下拖动调整高度，下拖到底关闭；轻点切换半屏和展开。上下方向键逐档调整，Home
            关闭，End 展开。
          </span>
        </button>
        {children}
      </SheetContext>
    </aside>
  );
}
