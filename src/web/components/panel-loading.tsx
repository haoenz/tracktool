export function PanelLoading({
  children = "正在加载…",
}: {
  children?: string;
}) {
  return (
    <div
      className="panel-loading"
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      {children}
    </div>
  );
}
