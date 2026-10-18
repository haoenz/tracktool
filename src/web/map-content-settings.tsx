import { useState } from "react";
import type { Project } from "../shared/project.js";
import type { MapConfig, MapPreset } from "../shared/map.js";
import {
  featureControls,
  featureReason,
  overlayReason,
} from "../drawing/layers.js";
import {
  Button,
  Checkbox,
  InputNumber,
  Select,
} from "./components/controls.js";
import {
  Popover,
  PopoverContent,
  PopoverAnchor,
} from "./components/ui/popover.js";

export function ReprojectionHelp() {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <Button
          size="sm"
          variant="ghost"
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          aria-expanded={open}
          aria-label="需重投影说明"
        >
          需重投影说明
        </Button>
      </PopoverAnchor>
      <PopoverContent
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        标有“需重投影”的图层会自动对齐坐标，首次加载可能稍慢，文字和细线可能略有柔化。
      </PopoverContent>
    </Popover>
  );
}
const hint = (source: MapPreset) =>
  source.crs === "gcj02" && source.format !== "vector" ? "需重投影" : undefined;

export function MapContentSettings({
  state,
  config,
  change,
  notify,
}: {
  state: Project;
  config: MapConfig;
  change: (edit: (next: Project) => void) => void;
  notify: (message: string) => void;
}) {
  const annotations = config.overlays.filter(
    (o) => o.category === "annotation",
  );
  const railways = config.overlays.filter((o) => o.content.includes("railway"));
  const enabled = (id: string) =>
    state.style.overlays.some((o) => o.id === id && o.enabled);
  function choose(sources: MapPreset[], id: string) {
    const source = sources.find((o) => o.id === id);
    const replaced = config.overlays.filter(
      (o) =>
        enabled(o.id) &&
        o.id !== id &&
        (sources.some((s) => s.id === o.id) ||
          source?.content.some((c) => o.content.includes(c))),
    );
    change((next) => {
      for (const overlay of next.style.overlays)
        if (
          sources.some((o) => o.id === overlay.id) ||
          replaced.some((o) => o.id === overlay.id)
        )
          overlay.enabled = false;
      if (source) {
        const old = next.style.overlays.find((o) => o.id === id);
        if (old) old.enabled = true;
        else next.style.overlays.push({ id, enabled: true, opacity: 1 });
      }
    });
    if (source && replaced.length)
      notify(
        `已用「${source.name}」替换「${replaced.map((o) => o.name).join("、")}」`,
      );
  }
  function opacity(source: MapPreset) {
    const overlay = state.style.overlays.find((o) => o.id === source.id);
    if (!overlay?.enabled) return null;
    return (
      <div className="settings-layer-options">
        <label htmlFor={`opacity-${source.id}`}>透明度（%）</label>
        <InputNumber
          id={`opacity-${source.id}`}
          aria-label={`${source.name}透明度`}
          min={10}
          max={100}
          step={10}
          value={Math.round(overlay.opacity * 100)}
          onChange={(value) =>
            change((next) => {
              const item = next.style.overlays.find((o) => o.id === source.id);
              if (item) item.opacity = (value ?? 100) / 100;
            })
          }
        />
      </div>
    );
  }
  function group(label: string, id: string, sources: MapPreset[]) {
    const selected = sources.find((o) => enabled(o.id));
    return (
      <div className="settings-content-row">
        <label htmlFor={id}>{label}</label>
        <Select
          id={id}
          searchable
          aria-label={label}
          value={selected?.id ?? "none"}
          options={[
            { value: "none", label: "无" },
            ...sources.map((o) => {
              const reason = overlayReason(state, config, o, false);
              return {
                value: o.id,
                label: o.name,
                hint:
                  [hint(o), reason].filter(Boolean).join(" · ") || undefined,
                disabled: !!reason,
              };
            }),
          ]}
          onChange={(value) => choose(sources, value)}
        />
        {sources.length > 0 &&
          sources.every((o) => overlayReason(state, config, o, false)) && (
            <p className="settings-reason">
              由底图提供同类内容，无法单独关闭或替换。
            </p>
          )}
        {selected && opacity(selected)}
      </div>
    );
  }
  return (
    <>
      <fieldset className="settings-group">
        <legend>地图内容</legend>
        {group("路网与地名注记", "settings-annotation", annotations)}
        <p className="settings-reason">
          底图或注记提供的内容随来源控制；其他内容可独立调整。
        </p>
        {Object.entries(featureControls).map(([key, [label, options]]) => {
          const reason = featureReason(state, config, key);
          return (
            <div className="settings-content-row" key={key}>
              <label htmlFor={`settings-feature-${key}`}>{label}</label>
              {reason ? (
                <p className="settings-provided" id={`settings-feature-${key}`}>
                  {reason}
                </p>
              ) : (
                <Select
                  id={`settings-feature-${key}`}
                  aria-label={label}
                  value={state.style.features[key]}
                  options={Object.entries(options).map(([value, name]) => ({
                    value,
                    label: name,
                  }))}
                  onChange={(value) =>
                    change((next) => {
                      next.style.features[key] = value;
                    })
                  }
                />
              )}
            </div>
          );
        })}
      </fieldset>
      <fieldset className="settings-group">
        <legend>专题图层</legend>
        {group("铁路", "settings-railway", railways)}
        {config.overlays
          .filter(
            (o) =>
              o.category !== "annotation" && !o.content.includes("railway"),
          )
          .map((o) => {
            const checked = enabled(o.id);
            const reason = overlayReason(state, config, o, false);
            return (
              <div key={o.id} className="settings-content-row">
                <Checkbox
                  checked={checked}
                  disabled={!!reason && !checked}
                  onCheckedChange={(value) =>
                    choose([o], value ? o.id : "none")
                  }
                >
                  {o.name}
                </Checkbox>
                {reason && <p className="settings-reason">{reason}</p>}
                {opacity(o)}
                {checked && o.id === "openinframap-power" && (
                  <div className="settings-layer-options">
                    <label htmlFor="settings-power-facilities">电力设施</label>
                    <Select
                      id="settings-power-facilities"
                      aria-label="电力设施"
                      value={state.style.power.facilities}
                      options={[
                        { value: "none", label: "仅线路" },
                        { value: "substations", label: "线路与变电站" },
                        { value: "generation", label: "线路与发电设施" },
                        { value: "all", label: "线路与全部设施" },
                      ]}
                      onChange={(value) =>
                        change((next) => {
                          next.style.power.facilities = value;
                        })
                      }
                    />
                    <label htmlFor="settings-power-voltage">
                      最低电压（kV）
                    </label>
                    <Select
                      id="settings-power-voltage"
                      aria-label="电力最低电压"
                      value={state.style.power.min_voltage}
                      options={[0, 110, 220, 500].map((value) => ({
                        value,
                        label: value ? String(value) : "不限",
                      }))}
                      onChange={(value) =>
                        change((next) => {
                          next.style.power.min_voltage = value;
                        })
                      }
                    />
                  </div>
                )}
              </div>
            );
          })}
      </fieldset>
    </>
  );
}
