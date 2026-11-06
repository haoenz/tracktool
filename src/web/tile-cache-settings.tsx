import { useEffect, useState } from "react";
import {
  TileCacheCapacitySchema,
  TileCacheSettingsSchema,
  type TileCacheSettings,
} from "../shared/tile-cache.js";
import { api } from "./api.js";
import { Button, Input } from "./components/controls.js";

export function TileCacheControl() {
  const [settings, setSettings] = useState<TileCacheSettings>();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setMessage("");
    void api("/api/settings/tile-cache", undefined, controller.signal)
      .then((body) => {
        const value = TileCacheSettingsSchema.parse(body);
        setSettings(value);
        setDraft(String(value.capacityMiB));
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setMessage(
            error instanceof Error ? error.message : "读取缓存设置失败",
          );
      });
    return () => controller.abort();
  }, [retry]);
  const save = async () => {
    const parsed = TileCacheCapacitySchema.safeParse(Number(draft));
    if (!parsed.success) {
      setMessage("请输入 1–16384 MiB 的整数");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const value = TileCacheSettingsSchema.parse(
        await api("/api/settings/tile-cache", { capacityMiB: parsed.data }),
      );
      setSettings(value);
      setDraft(String(value.capacityMiB));
      setMessage("缓存容量已保存并生效");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存缓存设置失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="mt-4 space-y-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (!busy && settings && !settings.readOnly) void save();
      }}
    >
      <label className="settings-field-label" htmlFor="tile-cache-capacity">
        服务端瓦片缓存上限（MiB）
      </label>
      <div className="flex gap-2">
        <Input
          id="tile-cache-capacity"
          type="number"
          min={1}
          max={16384}
          step={1}
          value={draft}
          disabled={!settings || settings.readOnly || busy}
          aria-describedby="tile-cache-help"
          onChange={(event) => {
            setDraft(event.target.value);
            setMessage("");
          }}
        />
        <Button
          type="submit"
          loading={busy}
          disabled={
            !settings ||
            settings.readOnly ||
            draft === String(settings.capacityMiB)
          }
        >
          保存
        </Button>
      </div>
      <p id="tile-cache-help" className="text-sm text-muted-foreground">
        {settings?.readOnly
          ? "容量由服务端配置控制。"
          : "范围 1–16384 MiB，1024 MiB = 1 GiB。调小后立即淘汰较久未使用的瓦片。"}
        上限按瓦片数据计算，磁盘占用还包含数据库开销，不影响轨迹数据。
      </p>
      {!settings && !message && <p role="status">正在读取缓存设置…</p>}
      {message && (
        <p role="status" className="text-sm">
          {message}
        </p>
      )}
      {!settings && message && (
        <Button onClick={() => setRetry(retry + 1)}>重试读取缓存设置</Button>
      )}
    </form>
  );
}
