import { useEffect, useRef, useState } from "react";
import { LocateFixed } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./components/controls.js";

export function MapLocationButton({
  disabled,
  onLocate,
}: {
  disabled: boolean;
  onLocate: (position: [number, number]) => void;
}) {
  const [locating, setLocating] = useState(false);
  const request = useRef(0);
  useEffect(() => {
    setLocating(false);
    // A late browser callback must not move a locked or unmounted map.
    return () => {
      request.current++;
    };
  }, [disabled]);

  const locate = () => {
    if (!window.isSecureContext) {
      toast.error("定位需要安全连接，请使用 HTTPS 或本机 localhost 访问。");
      return;
    }
    if (!navigator.geolocation) {
      toast.error("当前浏览器不支持定位，请换用支持定位的浏览器。");
      return;
    }
    const sequence = ++request.current;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        if (request.current !== sequence) return;
        setLocating(false);
        onLocate([coords.longitude, coords.latitude]);
      },
      (error) => {
        if (request.current !== sequence) return;
        setLocating(false);
        toast.error(
          error.code === 1
            ? "定位权限被拒绝，请在浏览器中允许访问位置后重试。"
            : error.code === 3
              ? "定位超时，请稍后重试。"
              : "暂时无法获取当前位置，请检查设备定位服务后重试。",
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  };

  return (
    <Button
      className="map-location-button"
      size="icon"
      title={locating ? "正在定位…" : "GPS 定位"}
      aria-label={locating ? "正在定位" : "GPS 定位"}
      disabled={disabled}
      loading={locating}
      onClick={locate}
    >
      {!locating && <LocateFixed aria-hidden="true" />}
    </Button>
  );
}
