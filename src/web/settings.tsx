import type { ReactNode } from "react";

export default function Settings({
  children,
  inProject = false,
}: {
  children?: ReactNode;
  inProject?: boolean;
}) {
  return (
    <div className="settings-panel">
      <p className="overview-hint">
        {inProject
          ? "当前在出图工程中，地图设置仅作用于当前工程。"
          : "调整浏览地图的底图、标注和叠加层。"}
      </p>
      {children ?? <p>地图资源就绪后可调整地图设置。</p>}
    </div>
  );
}
