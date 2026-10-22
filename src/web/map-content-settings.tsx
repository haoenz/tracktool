import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import type { Project } from "../shared/project.js";
import type { MapConfig, MapPreset } from "../shared/map.js";
import {
  featureControls,
  featureGroups,
  featureReason,
  overlayReason,
} from "../drawing/layers.js";
import {
  InputNumber,
  RadioGroup,
  Switch,
  Select,
} from "./components/controls.js";

const powerFacilities = [
  { value: "none", label: "仅线路" },
  { value: "substations", label: "线路与变电站" },
  { value: "generation", label: "线路与发电设施" },
  { value: "all", label: "线路与全部设施" },
];
function FeatureGroup({
  label,
  keys,
  state,
  config,
  change,
}: {
  label: string;
  keys: string[];
  state: Project;
  config: MapConfig;
  change: (edit: (next: Project) => void) => void;
}) {
  const items = keys
    .filter((key) => !featureReason(state, config, key))
    .map((key) => {
      const [name, options] = featureControls[key]!;
      return { key, label: name, options };
    });
  if (!items.length) return null;
  return (
    <fieldset className="settings-group settings-subgroup">
      <legend>{label}</legend>
      {items.map((item) => (
        <div className="settings-feature" key={item.key}>
          <span className="settings-choice-label">{item.label}</span>
          <RadioGroup
            aria-label={item.label}
            variant="segmented"
            value={state.style.features[item.key] ?? "none"}
            // Strongest option first, "关闭" last.
            options={Object.entries(item.options)
              .reverse()
              .map(([value, name]) => ({ value, label: name }))}
            onValueChange={(value) =>
              change((next) => {
                next.style.features[item.key] = value;
              })
            }
          />
        </div>
      ))}
    </fieldset>
  );
}

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
  const [expanded, setExpanded] = useState<string[]>([]);
  const toggle = (id: string) =>
    setExpanded((ids) =>
      ids.includes(id) ? ids.filter((o) => o !== id) : [...ids, id],
    );
  const annotations = config.overlays.filter(
    (o) => o.category === "annotation",
  );
  const railways = config.overlays.filter((o) => o.content.includes("railway"));
  const topics = [
    { id: "railway", label: "铁路", sources: railways },
    ...config.overlays
      .filter(
        (o) => o.category !== "annotation" && !o.content.includes("railway"),
      )
      .map((o) => ({
        id: o.id,
        label:
          o.id === "openinframap-power"
            ? "电力"
            : o.id === "openseamap-seamarks"
              ? "航标"
              : o.name,
        sources: [o],
      })),
  ];
  const stored = (id: string) => state.style.overlays.find((o) => o.id === id);
  const available = (source: MapPreset) =>
    !overlayReason(state, config, source, false);
  const selectedAnnotation = annotations.find((o) => stored(o.id)?.enabled);
  const availableAnnotations = annotations.filter(available);
  // Older projects can retain several disabled railway variants. Present them
  // as one layer, preferring the active variant, without rewriting on load.
  const selectedSource = (sources: MapPreset[]) =>
    sources.find((o) => stored(o.id)?.enabled) ??
    sources.find((o) => stored(o.id));
  const sourceFor = (sources: MapPreset[]) =>
    selectedSource(sources) ?? sources.find(available) ?? sources[0];
  // Incompatible sources are hidden instead of explained.
  const visibleTopics = topics.filter((topic) => {
    const source = sourceFor(topic.sources);
    return Boolean(source && available(source));
  });
  const hasFeatureControls = featureGroups.some((group) =>
    group.keys.some((key) => !featureReason(state, config, key)),
  );

  function choose(sources: MapPreset[], id: string, enable = true) {
    const source = sources.find((o) => o.id === id);
    if (source && enable && !available(source)) return;
    const replaced = config.overlays.filter(
      (o) =>
        stored(o.id)?.enabled &&
        o.id !== id &&
        (sources.some((s) => s.id === o.id) ||
          (enable && source?.content.some((c) => o.content.includes(c)))),
    );
    const previousOpacity =
      sources.map((o) => stored(o.id)).find((o) => o?.enabled)?.opacity ??
      stored(selectedSource(sources)?.id ?? "")?.opacity ??
      1;
    change((next) => {
      for (const overlay of next.style.overlays)
        if (
          sources.some((o) => o.id === overlay.id) ||
          replaced.some((o) => o.id === overlay.id)
        )
          overlay.enabled = false;
      if (source) {
        const old = next.style.overlays.find((o) => o.id === id);
        if (old) old.enabled = enable;
        else
          next.style.overlays.push({
            id,
            enabled: enable,
            opacity: previousOpacity,
          });
        // Source changes replace a topic's saved variant; toggling it off keeps
        // that variant and its parameters available on the main list.
        next.style.overlays = next.style.overlays.filter(
          (o) => o.id === id || !sources.some((s) => s.id === o.id),
        );
      }
    });
    if (source && enable && replaced.length)
      notify(
        `已用「${source.name}」替换「${replaced.map((o) => o.name).join("、")}」`,
      );
  }
  return (
    <>
      {(availableAnnotations.length > 0 || hasFeatureControls) && (
        <fieldset className="settings-group">
          {availableAnnotations.length > 0 && (
            <>
              <span className="settings-field-label">路网</span>
              <div className="settings-annotation-row">
                <Select
                  aria-label="路网"
                  value={selectedAnnotation?.id ?? "none"}
                  options={[
                    { value: "none", label: "关闭" },
                    ...availableAnnotations.map((o) => ({
                      value: o.id,
                      label: o.name,
                    })),
                  ]}
                  onChange={(value) => choose(annotations, value)}
                />
                {selectedAnnotation && (
                  <span className="settings-inline-opacity">
                    <span className="settings-inline-opacity-label">
                      不透明度
                    </span>
                    <InputNumber
                      aria-label="路网不透明度"
                      min={1}
                      max={100}
                      step={1}
                      precision={0}
                      value={Math.round(
                        (stored(selectedAnnotation.id)?.opacity ?? 1) * 100,
                      )}
                      onChange={(value) =>
                        change((next) => {
                          const item = next.style.overlays.find(
                            (o) => o.id === selectedAnnotation.id,
                          );
                          if (item) item.opacity = (value ?? 100) / 100;
                        })
                      }
                    />
                    <span aria-hidden="true">%</span>
                  </span>
                )}
              </div>
            </>
          )}
          {hasFeatureControls && (
            <>
              <span className="settings-field-label settings-section-label">
                常用信息
              </span>
              {featureGroups.map((group) => (
                <FeatureGroup
                  key={group.label}
                  label={group.label}
                  keys={group.keys}
                  state={state}
                  config={config}
                  change={change}
                />
              ))}
            </>
          )}
        </fieldset>
      )}
      {visibleTopics.length > 0 && (
        <fieldset className="settings-group">
          <legend>附加图层</legend>
          {visibleTopics.map((topic) => {
            const source = sourceFor(topic.sources)!;
            const overlay = stored(source.id);
            const enabled = overlay?.enabled ?? false;
            // The summary sits beside the layer name and only moves below it when
            // the name leaves too little room for one line.
            const summary =
              topic.id === "railway"
                ? source.name
                : topic.id === "openinframap-power"
                  ? `${powerFacilities.find((o) => o.value === state.style.power.facilities)?.label} · ${state.style.power.min_voltage ? `≥ ${state.style.power.min_voltage} kV` : "电压不限"}`
                  : "";
            const expandable =
              topic.sources.length > 1 || topic.id === "openinframap-power";
            const open = expanded.includes(topic.id);
            const heading = (
              <>
                <span className="settings-layer-chevron" aria-hidden="true">
                  {expandable && (
                    <ChevronRightIcon className="settings-layer-chevron-icon" />
                  )}
                </span>
                <span className="settings-layer-name">{topic.label}</span>
                {summary && (
                  <span className="settings-layer-note">{summary}</span>
                )}
              </>
            );
            return (
              <div
                className="settings-layer"
                key={topic.id}
                role="group"
                aria-label={`${topic.label}图层`}
              >
                <div className="settings-layer-heading">
                  {expandable ? (
                    <button
                      type="button"
                      className="settings-layer-toggle"
                      aria-expanded={open}
                      aria-controls={`layer-panel-${topic.id}`}
                      onClick={() => toggle(topic.id)}
                    >
                      {heading}
                    </button>
                  ) : (
                    <div className="settings-layer-toggle">{heading}</div>
                  )}
                  {/* The width stays reserved while the layer is off, otherwise the
                    summary would reflow and change the card height. */}
                  <span
                    className="settings-inline-opacity"
                    data-hidden={!enabled}
                    aria-hidden={!enabled}
                  >
                    <span className="settings-inline-opacity-label">
                      不透明度
                    </span>
                    <InputNumber
                      aria-label={`${topic.label}不透明度`}
                      min={1}
                      max={100}
                      step={1}
                      precision={0}
                      disabled={!enabled}
                      value={Math.round((overlay?.opacity ?? 1) * 100)}
                      onChange={(value) =>
                        change((next) => {
                          const item = next.style.overlays.find(
                            (o) => o.id === source.id,
                          );
                          if (item) item.opacity = (value ?? 100) / 100;
                        })
                      }
                    />
                    <span aria-hidden="true">%</span>
                  </span>
                  <Switch
                    id={`layer-${topic.id}`}
                    aria-label={`${topic.label}图层`}
                    checked={enabled}
                    onCheckedChange={(checked) =>
                      choose(topic.sources, source.id, checked)
                    }
                  />
                </div>
                {expandable && (
                  <div
                    className="settings-layer-panel"
                    id={`layer-panel-${topic.id}`}
                    hidden={!open}
                  >
                    {topic.sources.length > 1 && (
                      <div className="settings-content-row">
                        <Select
                          id={`source-${topic.id}`}
                          aria-label={`${topic.label}显示内容`}
                          value={source.id}
                          options={topic.sources
                            .filter((o) => available(o) || o.id === source.id)
                            .map((o) => ({ value: o.id, label: o.name }))}
                          onChange={(value) =>
                            choose(topic.sources, value, enabled)
                          }
                        />
                      </div>
                    )}
                    {topic.id === "openinframap-power" && (
                      <div className="settings-layer-options">
                        <label htmlFor="settings-power-facilities">
                          电力设施
                        </label>
                        <Select
                          id="settings-power-facilities"
                          aria-label="电力设施"
                          value={state.style.power.facilities}
                          options={powerFacilities}
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
                )}
              </div>
            );
          })}
        </fieldset>
      )}
    </>
  );
}
