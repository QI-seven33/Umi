export function ThinkingIndicator({ label = "Umi正在暴打宿傩..." }: { label?: string }) {
  return (
    <span className="thinking-indicator" aria-label={label}>
      <span className="thinking-dot" />
      <span key={label} className="thinking-label">{label}</span>
    </span>
  );
}
