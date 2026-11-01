import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Map, Route } from "lucide-react";
import { Button, Select } from "./components/controls.js";
import { PanelHeader } from "./components/panel-header.js";
import { useTheme } from "./theme.js";

export default function Settings({
  children,
  tracks,
  status,
}: {
  children?: ReactNode;
  tracks?: ReactNode;
  status?: ReactNode;
}) {
  const { theme, setTheme } = useTheme();
  const [section, setSection] = useState<"map" | "tracks">();
  const panel = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  useLayoutEffect(() => {
    if (previousSection.current === section) return;
    const target = panel.current?.querySelector<HTMLElement>(
      section ? "h2" : `[data-settings-${previousSection.current}]`,
    );
    previousSection.current = section;
    target?.focus({ preventScroll: true });
    const controls = panel.current?.closest(".map-controls");
    if (controls) controls.scrollTop = 0;
  }, [section]);
  return (
    <div className="settings-panel" ref={panel}>
      <PanelHeader
        title={
          section === "map"
            ? "地图设置"
            : section === "tracks"
              ? "轨迹样式"
              : "设置"
        }
        backLabel={section ? "返回设置" : undefined}
        onBack={section ? () => setSection(undefined) : undefined}
      />
      {status}
      {section === "map" ? (
        <>{children ?? <p>地图资源就绪后可调整地图设置。</p>}</>
      ) : section === "tracks" ? (
        <>{tracks ?? <p>地图资源就绪后可调整轨迹样式。</p>}</>
      ) : (
        <>
          <div className="settings-appearance">
            <label
              className="settings-field-label"
              htmlFor="settings-appearance"
            >
              配色
            </label>
            <Select
              id="settings-appearance"
              aria-label="配色"
              value={theme}
              onChange={setTheme}
              options={[
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
                { value: "system", label: "跟随系统" },
              ]}
            />
          </div>
          <Button
            data-settings-map
            block
            variant="ghost"
            className="mt-4 h-12 justify-start"
            onClick={() => setSection("map")}
          >
            <Map aria-hidden="true" />
            地图设置
            <ChevronRight className="ml-auto" aria-hidden="true" />
          </Button>
          <Button
            data-settings-tracks
            block
            variant="ghost"
            className="h-12 justify-start"
            onClick={() => setSection("tracks")}
          >
            <Route aria-hidden="true" />
            轨迹样式
            <ChevronRight className="ml-auto" aria-hidden="true" />
          </Button>
        </>
      )}
    </div>
  );
}
