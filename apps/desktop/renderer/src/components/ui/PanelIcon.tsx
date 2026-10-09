export function PanelIcon({ side = "left", size = 17 }: { side?: "left" | "right"; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="4" ry="4" />
      {side === "left"
        ? <line x1="9.5" y1="4" x2="9.5" y2="20" />
        : <line x1="14.5" y1="4" x2="14.5" y2="20" />}
    </svg>
  );
}
