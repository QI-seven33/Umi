import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import type { Message } from "../../types/index.js";
import type { Snapshot } from "../../transport.js";

/** 历史预览与正文使用同一消息序号边界，避免把后续任务的回复归到旧消息下。 */
export function projectHistoryPreview(snapshot: Snapshot | null): Message[] {
  if (!snapshot) return [];
  const users = [...snapshot.messages].sort((a, b) =>
    BigInt(a.projectionSequence) < BigInt(b.projectionSequence) ? -1 : 1);
  const finalBlocks = snapshot.state.blocks.filter(block => block.kind === "text" && block.displayRole === "final")
    .sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : 1);
  return users.flatMap((user, index): Message[] => {
    const from = BigInt(user.projectionSequence);
    const next = users[index + 1];
    const to = next ? BigInt(next.projectionSequence) : null;
    const blocks = finalBlocks.filter(block => block.runId === user.runId &&
      BigInt(block.sequence) > from && (to === null || BigInt(block.sequence) < to));
    const text = blocks.map(block => block.text).join("\n\n");
    const result: Message[] = [{id:user.id, messageId:user.id, role:"user", text:user.payload.content,
      createdAt:Date.parse(user.createdAt), attachments:user.attachments.map(attachment => ({
        id:attachment.id, name:attachment.name, size:attachment.byteLength,
        kind:attachment.mime.startsWith("image/") ? "image" : "text",
      }))}];
    if (text) result.push({id:`preview-${user.id}`, messageId:`preview-${user.id}`, role:"assistant", text,
      createdAt:snapshot.state.runs[user.runId]?.finishedAt ? Date.parse(snapshot.state.runs[user.runId]!.finishedAt!) : null});
    return result;
  });
}

/** 右侧历史刻度：邻近刻度随悬停渐变，预览跟随对应消息的位置。 */
export function ConversationMap({ messages, canvasRef }: {
  messages: Message[]; canvasRef: RefObject<HTMLElement | null>;
}) {
  const turns = useMemo(() => messages.filter((message) => message.role === "user"), [messages]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [previewY, setPreviewY] = useState(0);
  const railRef = useRef<HTMLElement>(null);
  const ticksRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = canvasRef.current;
    if (!root || !turns.length) return;
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const edge = root.getBoundingClientRect().top + 90;
        let current = turns[0]!.id;
        for (const turn of turns) {
          const element = document.getElementById(`msg-${turn.id}`);
          if (element && element.getBoundingClientRect().top <= edge) current = turn.id;
        }
        setActiveId(current);
      });
    };
    refresh();
    root.addEventListener("scroll", refresh, { passive: true });
    return () => { root.removeEventListener("scroll", refresh); cancelAnimationFrame(frame); };
  }, [canvasRef, turns]);

  useEffect(() => {
    const ticks = ticksRef.current;
    const current = ticks?.querySelector<HTMLButtonElement>("button.active");
    // 仅随当前消息变化自动跟随；悬停结束不应重置用户手动滚动的历史刻度。
    if (ticks && current && !ticks.matches(":hover") && !ticks.contains(document.activeElement)) {
      // 只滚动刻度容器，避免 scrollIntoView 顺带移动消息区或页面。
      const top = current.offsetTop - ticks.offsetTop;
      if (top < ticks.scrollTop) ticks.scrollTop = top;
      else if (top + current.offsetHeight > ticks.scrollTop + ticks.clientHeight)
        ticks.scrollTop = top + current.offsetHeight - ticks.clientHeight;
    }
  }, [activeId]);

  if (!turns.length) return null;
  const hoveredIndex = turns.findIndex((turn) => turn.id === hoveredId);
  const previewIndex = messages.findIndex((message) => message.id === previewId);
  const preview = messages[previewIndex];
  const answer = previewIndex >= 0 && messages[previewIndex + 1]?.role === "assistant"
    ? messages[previewIndex + 1] : undefined;
  const showPreview = (id: string, button: HTMLButtonElement) => {
    const rail = railRef.current;
    if (!rail) return;
    const bounds = rail.getBoundingClientRect();
    const center = button.getBoundingClientRect().top - bounds.top + button.offsetHeight / 2;
    setPreviewY(Math.max(58, Math.min(Math.max(58, bounds.height - 58), center)));
    setHoveredId(id); setPreviewId(id);
  };
  return <nav ref={railRef} className="conversation-map" aria-label="历史消息时间线"
    onMouseLeave={() => setHoveredId(null)}>
    <div ref={ticksRef} className="conversation-map-ticks">
      {turns.map((turn, index) => {
        const distance = hoveredIndex < 0 ? Infinity : Math.abs(index - hoveredIndex);
        const width = distance < 5 ? 10 + 21 * Math.exp(-distance * .55): 9;
        return <button key={turn.id} type="button" className={turn.id === activeId ? "active" : ""}
          aria-label={`跳转到第 ${index + 1} 轮${timestamp(turn.createdAt)}`}
          aria-current={turn.id === activeId ? "location" : undefined}
          style={{ "--tick-width": `${width}px` } as CSSProperties}
          onMouseEnter={(event) => showPreview(turn.id, event.currentTarget)}
          onFocus={(event) => showPreview(turn.id, event.currentTarget)}
          onBlur={() => setHoveredId(null)}
          onClick={() => {
            const root = canvasRef.current;
            const element = document.getElementById(`msg-${turn.id}`);
            if (root && element) root.scrollTo({ top: root.scrollTop + element.getBoundingClientRect().top
              - root.getBoundingClientRect().top - 24, behavior: "smooth" });
          }}><span /></button>;
      })}
    </div>
    <div className={`conversation-map-preview ${hoveredId && preview ? "is-visible" : ""}`}
      role="tooltip" aria-hidden={!hoveredId} style={{ "--preview-y": `${previewY}px` } as CSSProperties}>
      {preview && <>
        <strong>{preview.text.trim() || preview.attachments?.map(attachment => attachment.name).join("、") || "附件消息"}</strong>
        {answer?.text && <p>{answer.text}</p>}
        <time dateTime={preview.createdAt ? new Date(preview.createdAt).toISOString() : undefined}>
          {timestamp(preview.createdAt) || "时间未记录"}
        </time>
      </>}
    </div>
  </nav>;
}

function timestamp(createdAt: number | null) {
  return createdAt && Number.isFinite(createdAt) ? new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(createdAt) : "";
}

