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
      <p className="settings-scope">
        {inProject ? "当前出图工程 · 保存工程后保留" : "浏览地图 · 自动保存"}
      </p>
      {children ?? <p>地图资源就绪后可调整地图设置。</p>}
    </div>
  );
}
