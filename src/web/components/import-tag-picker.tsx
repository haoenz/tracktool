import { useState } from "react";
import { Check } from "lucide-react";
import type { PublicConfig } from "../../shared/contracts.js";
import { Button } from "./controls.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";

const groups = [
  { key: "Default", label: "普通" },
  { key: "Train", label: "轨道" },
  { key: "Flight", label: "飞行" },
] as const;

export function isRegisteredImportTag(
  config: PublicConfig | undefined,
  tag: string | undefined,
) {
  return groups.some((group) =>
    config?.[`track_tag.${group.key}`].some((value) => value === tag),
  );
}

export function ImportTagPicker({
  config,
  sourceTag,
  value,
  onChange,
}: {
  config?: PublicConfig;
  sourceTag?: string;
  value?: string;
  onChange: (value: string) => void;
}) {
  const [browsingGroup, setBrowsingGroup] = useState<string>();
  const choices = groups.map((group) => ({
    ...group,
    tags: config?.[`track_tag.${group.key}`] ?? [],
  }));
  const source = sourceTag?.trim();
  const selected = value ?? source;
  const selectedGroup = choices.find((group) =>
    group.tags.some((tag) => tag === selected),
  );
  const sourceRegistered = isRegisteredImportTag(config, source);

  return (
    <fieldset className="import-tag-picker" aria-label="活动标签">
      <legend>
        活动标签{" "}
        <span className={source ? "import-tag-source" : "import-tag-missing"}>
          {source ? `${source}${sourceRegistered ? "" : "（未登记）"}` : "缺失"}
        </span>
      </legend>
      <Tabs
        value={browsingGroup ?? selectedGroup?.key ?? "Default"}
        onValueChange={setBrowsingGroup}
      >
        <TabsList className="w-full" aria-label="活动标签分组">
          {choices.map((group) => (
            <TabsTrigger key={group.key} value={group.key}>
              {group.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {choices.map((group) => (
          <TabsContent key={group.key} value={group.key}>
            {group.tags.length ? (
              <div className="import-tag-grid">
                {group.tags.map((tag) => (
                  <Button
                    key={tag}
                    type="button"
                    variant={selected === tag ? "secondary" : "outline"}
                    aria-pressed={selected === tag}
                    onClick={() => onChange(tag)}
                  >
                    {selected === tag && <Check aria-hidden="true" />}
                    {tag}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="import-tag-source">此分组暂无标签</p>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </fieldset>
  );
}
