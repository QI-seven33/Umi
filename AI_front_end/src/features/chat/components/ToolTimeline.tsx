import { useState } from "react";
import { ChevronRight, Search } from "lucide-react";

import type { ToolStep } from "../../../types";
import { TOOL_ICONS, verbOf } from "../../../utils/constants";
import { cn } from "../../../utils/dom";
import { ThinkingIndicator } from "../../../components/ui/ThinkingIndicator";

export function ToolTimeline({
  steps, streaming, activeLabel, hasAnyText,
}: {
  steps: ToolStep[];
  streaming: boolean;
  activeLabel: string;
  hasAnyText: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (!streaming || hasAnyText) return null;

  const anyRunning = steps.some((s) => s.status === "running");
  const hasSteps = steps.length > 0;

  return (
    <div data-slot="tool-timeline" className={cn("tool-timeline")}>
      {hasSteps && (
        <button type="button" className="tool-timeline-trigger"
          onClick={() => setOpen((o) => !o)} aria-expanded={open}>
          <ChevronRight size={14} className={cn("tool-timeline-chevron", open && "open")} />
          <span className={cn("tool-timeline-label", anyRunning && "shimmer")}>
            {anyRunning ? activeLabel : "已完成"}
          </span>
        </button>
      )}

      {hasSteps && (
        <div className={cn("tool-timeline-panel", open && "open")}>
          <div className="tool-timeline-inner">
            {steps.map((step, index) => {
              const Icon = TOOL_ICONS[step.name] ?? Search;
              const active = index === steps.length - 1 && step.status === "running";
              return (
                <div key={`${step.name}-${index}`} className="tool-step">
                  <Icon size={13} className="tool-step-icon" />
                  <span className={cn("tool-step-verb", active && "shimmer")}>
                    {verbOf(step.name)}
                  </span>
                  <span className="tool-step-chip">{step.name}</span>
                  <span className={cn("tool-step-status", step.status)}>
                    {step.status === "running" ? "…" : step.status === "error" ? "!" : "✓"}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="tool-timeline-thinking">
        <ThinkingIndicator />
      </div>
    </div>
  );
}
