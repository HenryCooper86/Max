import { useEffect, useState } from "react";
import { useSay } from "./hooks";
import { copyText } from "./session";

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const say = useSay();
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => window.clearTimeout(timer);
  }, [state]);
  return (
    <button
      type="button"
      className="siteButton secondary small"
      onClick={() => void copyText(text).then((ok) => setState(ok ? "copied" : "failed"))}
    >
      <span aria-live="polite">
        {state === "copied"
          ? say("已复制", "Copied")
          : state === "failed"
            ? say("复制失败，请手动选择", "Copy failed. Select it by hand")
            : (label ?? say("复制", "Copy"))}
      </span>
    </button>
  );
}
