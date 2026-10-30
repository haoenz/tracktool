import { useEffect, useMemo, useRef, useState } from "react";
import type { MapConfig } from "../shared/map.js";
import { Button } from "./components/controls.js";
import {
  activeVendor,
  basemapChoices,
  groupBasemaps,
} from "./basemap-catalog.js";

/** Vendor column plus map list; lives outside the workspace to keep the page lean. */
export function BasemapPicker({
  config,
  crs,
  value,
  error,
  onPick,
  onRetry,
}: {
  config: MapConfig;
  crs: "wgs84" | "gcj02";
  value: string;
  error?: string;
  onPick: (id: string) => void;
  onRetry?: () => void;
}) {
  const groups = useMemo(
    () => groupBasemaps(basemapChoices(config, crs)),
    [config, crs],
  );
  const active = activeVendor(groups, value);
  const [vendor, setVendor] = useState("");
  const shownVendor = groups.some(([name]) => name === vendor)
    ? vendor
    : active;
  const shown = groups.find(([name]) => name === shownVendor)?.[1] ?? [];
  const list = useRef<HTMLDivElement | null>(null);
  // Switching the basemap (including undo) realigns the vendor column.
  useEffect(() => setVendor(""), [value]);
  // Keep the active row visible when the column scrolls.
  useEffect(() => {
    list.current
      ?.querySelector('[aria-pressed="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [shownVendor, value]);
  return (
    <>
      <span className="settings-field-label" id="settings-basemap-label">
        图源
      </span>
      <div
        className="settings-basemap"
        role="group"
        aria-labelledby="settings-basemap-label"
        aria-describedby={error ? "settings-basemap-error" : undefined}
      >
        <div className="settings-basemap-columns">
          <div
            className="settings-vendor-list"
            role="group"
            aria-label="供应商"
          >
            {groups.map(([name]) => (
              <button
                key={name}
                type="button"
                className="settings-vendor-option"
                aria-pressed={name === shownVendor}
                onClick={() => setVendor(name)}
              >
                {name}
                <span
                  className="settings-vendor-dot"
                  data-active={name === active}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
          <div
            className="settings-map-list"
            role="group"
            aria-label={shownVendor}
            ref={list}
          >
            {shown.map((item) => (
              <button
                key={item.value}
                type="button"
                className="settings-map-option"
                aria-label={item.label}
                aria-pressed={value === item.value}
                onClick={() => onPick(item.value)}
              >
                <span className="settings-map-name">{item.label}</span>
                {value === item.value && (
                  <span className="settings-map-badge">当前</span>
                )}
                {item.hint && (
                  <span className="settings-map-hint">{item.hint}</span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
      {error && (
        <p className="settings-error" id="settings-basemap-error" role="alert">
          {error}
          {onRetry && (
            <Button size="sm" variant="ghost" onClick={onRetry}>
              重试
            </Button>
          )}
        </p>
      )}
    </>
  );
}
