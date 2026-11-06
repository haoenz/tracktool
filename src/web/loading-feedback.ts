import { useEffect, useRef, useState } from "react";

/** Keep adjacent loading phases in one indicator without flashing on fast reads. */
export function useLoadingFeedback(active: boolean, task = "") {
  const [visible, setVisible] = useState(false);
  const [slow, setSlow] = useState(false);
  const shownAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (active) {
      if (shownAt.current === undefined)
        timer = setTimeout(() => {
          shownAt.current = Date.now();
          setVisible(true);
        }, 180);
    } else {
      timer = setTimeout(
        () => {
          shownAt.current = undefined;
          setVisible(false);
        },
        Math.max(180, 400 - (Date.now() - (shownAt.current ?? 0))),
      );
    }
    return () => clearTimeout(timer);
  }, [active]);
  useEffect(() => {
    setSlow(false);
    if (!active) return;
    const timer = setTimeout(() => setSlow(true), 8000);
    return () => clearTimeout(timer);
  }, [active, task]);
  return { visible, slow: active && slow };
}
