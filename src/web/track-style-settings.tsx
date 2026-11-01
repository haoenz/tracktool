import { useId, useState } from "react";
import {
  readEntryVisibility,
  saveEntryVisibility,
  type EntryVisibility,
} from "./visibility-preference.js";
import {
  defaultTrackAppearance,
  TRACK_KINDS,
  TRACK_STYLES,
} from "../shared/track-style.js";
import type { MapState } from "../shared/map-state.js";
import { Button, Input, InputNumber, Select } from "./components/controls.js";

function WidthControl({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="settings-choice-label">
        线宽
      </label>
      <div className="flex items-center gap-3">
        <Input
          type="range"
          aria-label={`${label}滑块`}
          min={1}
          max={8}
          step={0.5}
          value={value}
          onChange={(event) => onChange(Number(event.target.value))}
          className="min-w-0 flex-1 border-0 px-0 shadow-none accent-primary"
        />
        <div className="w-20 shrink-0">
          <InputNumber
            id={id}
            aria-label={label}
            min={1}
            max={8}
            step={0.5}
            precision={1}
            value={value}
            onChange={(next) => {
              if (next !== undefined && next !== null) onChange(next);
            }}
          />
        </div>
      </div>
    </div>
  );
}

export function TrackStyleSettings({
  state,
  change,
}: {
  state: MapState;
  change: (edit: (next: MapState) => void) => void;
}) {
  const style = state.style.tracks;
  const [entryVisibility, setEntryVisibility] =
    useState<EntryVisibility>(readEntryVisibility);

  return (
    <div className="track-style-settings">
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

      <fieldset className="settings-group">
        <legend>全部轨迹</legend>
        <div className="settings-track-fields">
          <WidthControl
            label="全部轨迹线宽"
            value={style.width}
            onChange={(width) =>
              change((next) => {
                next.style.tracks.width = width;
              })
            }
          />
          <div className="grid grid-cols-[minmax(0,1fr)_2.75rem_6.5rem] items-center gap-2">
            <span className="settings-track-column-label">类别</span>
            <span className="settings-track-column-label">颜色</span>
            <span className="settings-track-column-label">不透明度</span>
            {TRACK_KINDS.map((kind) => (
              <CategoryRow
                key={kind}
                kind={kind}
                state={state}
                change={change}
              />
            ))}
          </div>
        </div>
      </fieldset>
      <fieldset className="settings-group">
        <legend>选中轨迹</legend>
        <div className="settings-track-fields">
          <div className="flex items-center justify-between gap-3">
            <label
              htmlFor="current-track-color"
              className="settings-choice-label"
            >
              颜色
            </label>
            <Input
              id="current-track-color"
              type="color"
              aria-label="选中轨迹颜色"
              value={style.current.color}
              className="w-11 shrink-0 p-1"
              onChange={(event) =>
                change((next) => {
                  next.style.tracks.current.color = event.target.value;
                })
              }
            />
          </div>
          <WidthControl
            label="选中轨迹线宽"
            value={style.current.width}
            onChange={(width) =>
              change((next) => {
                next.style.tracks.current.width = width;
              })
            }
          />
        </div>
      </fieldset>
      <div className="pt-5">
        <Button
          block
          onClick={() =>
            change((next) => {
              next.style.tracks = defaultTrackAppearance();
            })
          }
        >
          恢复默认样式
        </Button>
      </div>
    </div>
  );
}

function CategoryRow({
  kind,
  state,
  change,
}: {
  kind: (typeof TRACK_KINDS)[number];
  state: MapState;
  change: (edit: (next: MapState) => void) => void;
}) {
  const label = TRACK_STYLES[kind].label;
  const style = state.style.tracks.categories[kind];
  return (
    <>
      <label htmlFor={`track-color-${kind}`} className="settings-choice-label">
        {label}
      </label>
      <Input
        id={`track-color-${kind}`}
        type="color"
        aria-label={`${label}颜色`}
        className="w-11 p-1"
        value={style.color}
        onChange={(event) =>
          change((next) => {
            next.style.tracks.categories[kind].color = event.target.value;
          })
        }
      />
      <div className="flex items-center gap-1">
        <InputNumber
          aria-label={`${label}不透明度`}
          min={5}
          max={100}
          step={1}
          precision={0}
          className="min-w-0 flex-1"
          value={Math.round(style.opacity * 100)}
          onChange={(value) => {
            if (value !== undefined && value !== null)
              change((next) => {
                next.style.tracks.categories[kind].opacity = value / 100;
              });
          }}
        />
        <span aria-hidden="true">%</span>
      </div>
    </>
  );
}
