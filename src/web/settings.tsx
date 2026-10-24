import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Map } from "lucide-react";
import { Button, Select } from "./components/controls.js";
import { PanelHeader } from "./components/panel-header.js";
import { useTheme } from "./theme.js";
import {
  readEntryVisibility,
  saveEntryVisibility,
  type EntryVisibility,
} from "./visibility-preference.js";

export default function Settings({
  children,
  inProject = false,
}: {
  children?: ReactNode;
  inProject?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const [entryVisibility, setEntryVisibility] =
    useState<EntryVisibility>(readEntryVisibility);
  const [section, setSection] = useState<"map">();
  const panel = useRef<HTMLDivElement>(null);
  const previousSection = useRef(section);
  useLayoutEffect(() => {
    if (previousSection.current === section) return;
    previousSection.current = section;
    const target = panel.current?.querySelector<HTMLElement>(
      section ? "h2" : "[data-settings-map]",
    );
    target?.focus({ preventScroll: true });
    const controls = panel.current?.closest(".map-controls");
    if (controls) controls.scrollTop = 0;
  }, [section]);
  return (
    <div className="settings-panel" ref={panel}>
      <PanelHeader
        title={section === "map" ? "地图设置" : "设置"}
        backLabel={section ? "返回设置" : undefined}
        onBack={section ? () => setSection(undefined) : undefined}
      />
      {section === "map" ? (
        <>
          <p className="settings-scope">
            {inProject
              ? "当前出图工程 · 保存工程后保留"
              : "浏览地图 · 自动保存"}
          </p>
          {children ?? <p>地图资源就绪后可调整地图设置。</p>}
        </>
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
          <div className="settings-entry-visibility">
            <label
              className="settings-field-label"
              htmlFor="settings-entry-visibility"
            >
              进入时轨迹
            </label>
            <Select
              id="settings-entry-visibility"
              aria-label="进入时轨迹"
              value={entryVisibility}
              onChange={(value: EntryVisibility) => {
                setEntryVisibility(value);
                saveEntryVisibility(value);
              }}
              options={[
                { value: "all", label: "全部显示" },
                { value: "none", label: "全部隐藏" },
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
        </>
      )}
    </div>
  );
}
