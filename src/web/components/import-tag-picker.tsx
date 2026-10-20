import type { PublicConfig } from "../../shared/contracts.js";
import { isRegisteredTag, TagPicker } from "./tag-picker.js";

export function ImportTagPicker({
  config,
  sourceTag,
  value,
  onChange,
  pending = false,
}: {
  config?: PublicConfig;
  sourceTag?: string;
  value?: string;
  onChange: (value: string) => void;
  /** The file has not been checked yet, so its tag is still unknown. */
  pending?: boolean;
}) {
  const source = sourceTag?.trim();
  const sourceRegistered = isRegisteredTag(config, source);

  return (
    <TagPicker
      config={config}
      value={value ?? source}
      onChange={onChange}
      legend={
        <>
          活动标签{" "}
          <span
            className={
              source || pending ? "tag-picker-note" : "tag-picker-missing"
            }
          >
            {source
              ? `${source}${config && !sourceRegistered ? "（未登记）" : ""}`
              : pending
                ? "读取中…"
                : "缺失"}
          </span>
        </>
      }
    />
  );
}
