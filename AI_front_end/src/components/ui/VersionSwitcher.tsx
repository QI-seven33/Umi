import type { MessageVersion } from "../../types";

// ─────────────────────────────────────────────────────────────
// 版本切换
// ─────────────────────────────────────────────────────────────

export function VersionSwitcher({
  versions, activeBranchNum, onSwitch, disabled,
}: {
  versions: MessageVersion[];
  activeBranchNum: number | null;
  onSwitch: (branchNum: number) => void;
  disabled?: boolean;
}) {
  if (versions.length <= 1) return null;
  const sorted = [...versions].sort((a, b) => a.branchNum - b.branchNum);
  const idx = activeBranchNum === null ? -1 : sorted.findIndex((v) => v.branchNum === activeBranchNum);
  const activeIdx = idx >= 0 ? idx : sorted.length - 1;

  return (
    <div className="version-switcher" role="group" aria-label="版本切换">
      <button type="button" className="version-arrow"
        onClick={() => onSwitch(sorted[Math.max(0, activeIdx - 1)].branchNum)}
        disabled={disabled || activeIdx <= 0} aria-label="上一个版本">‹</button>
      <span className="version-count">{activeIdx + 1} / {sorted.length}</span>
      <button type="button" className="version-arrow"
        onClick={() => onSwitch(sorted[Math.min(sorted.length - 1, activeIdx + 1)].branchNum)}
        disabled={disabled || activeIdx >= sorted.length - 1} aria-label="下一个版本">›</button>
    </div>
  );
}
