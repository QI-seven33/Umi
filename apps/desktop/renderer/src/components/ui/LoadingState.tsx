import { useEffect, useState } from "react";

/** 九宫格加载状态：只用于一次运行尚未产出可展示内容的短暂空档。 */
export function GenerationLoader({ label, compact = false }: {
  label: string;
  compact?: boolean;
}) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => setTick((value) => value + 1), 120);
    return () => window.clearInterval(timer);
  }, []);

  const head = tick % 9;
  return <div className={`generation-loader ${compact ? "compact" : ""}`}
    role="status" aria-label={label}>
    <span className="generation-loader-grid" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => {
        const distance = (head - index + 9) % 9;
        return <i className={distance === 0 ? "is-head" : distance <= 2 ? "is-trail" : ""}
          key={index} />;
      })}
    </span>
    <span className="generation-loader-label">{label}</span>
  </div>;
}