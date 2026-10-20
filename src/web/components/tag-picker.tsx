import { useState } from "react";
import type { ReactNode } from "react";
import { Check } from "lucide-react";
import type { PublicConfig } from "../../shared/contracts.js";
import { Button } from "./controls.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs.js";

export const tagGroups = [
  { key: "Default", label: "普通" },
  { key: "Train", label: "轨道" },
  { key: "Flight", label: "飞行" },
] as const;

export function isRegisteredTag(
  config: PublicConfig | undefined,
  tag: string | undefined,
) {
  return tagGroups.some((group) =>
    config?.[`track_tag.${group.key}`].some((value) => value === tag),
  );
}

export function TagPicker({
  config,
  value,
  onChange,
  legend,
  ariaLabel = "活动标签",
}: {
  config?: PublicConfig;
  value?: string;
  onChange: (value: string) => void;
  legend?: ReactNode;
  ariaLabel?: string;
}) {
  const [browsingGroup, setBrowsingGroup] = useState<string>();
  const choices = tagGroups.map((group) => ({
    ...group,
    tags: config?.[`track_tag.${group.key}`] ?? [],
  }));
  const selectedGroup = choices.find((group) =>
    group.tags.some((tag) => tag === value),
  );

  return (
    <fieldset className="tag-picker" aria-label={ariaLabel}>
      {legend && <legend>{legend}</legend>}
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
              <div className="tag-picker-grid">
                {group.tags.map((tag) => (
                  <Button
                    key={tag}
                    type="button"
                    variant={value === tag ? "secondary" : "outline"}
                    aria-pressed={value === tag}
                    onClick={() => onChange(tag)}
                  >
                    {value === tag && <Check aria-hidden="true" />}
                    {tag}
                  </Button>
                ))}
              </div>
            ) : (
              <p className="tag-picker-note">此分组暂无标签</p>
            )}
          </TabsContent>
        ))}
      </Tabs>
    </fieldset>
  );
}
