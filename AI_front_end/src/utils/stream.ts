export type StreamEvent =
  | { type: "text"; content: string }
  | { type: "tool_call"; name: string; status: "running" }
  | { type: "tool_result"; name: string; status: "done" };

export function readSseStream(
  response: Response,
  onEvent: (evt: StreamEvent) => void,
  signal?: AbortSignal,
) {
  const reader = response.body?.getReader();
  if (!reader) {
    return {
      promise: Promise.reject(new Error("浏览器不支持流式响应。")),
      cancel: () => { },
    };
  }
  const decoder = new TextDecoder();
  let buffer = "";

  const cancel = () => { reader.cancel().catch(() => { }); };

  const promise = (async () => {
    try {
      while (true) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => { });
          throw new DOMException("Aborted", "AbortError");
        }
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const packets = buffer.split("\n\n");
        buffer = packets.pop() ?? "";

        for (const packet of packets) {
          const lines = packet.replaceAll("\r", "").split("\n");
          const event = lines.find((l) => l.startsWith("event:"))?.slice(6).trim();
          const data = lines.filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).replace(/^\s/, "")).join("\n");

          if (event === "error") throw new Error(data || "服务暂时不可用，请稍后重试。");
          if (event === "message" && data) {
            onEvent({ type: "text", content: readStreamPayload(data) });
          }
          if (event === "tool_call" && data) {
            const v = JSON.parse(data);
            onEvent({ type: "tool_call", name: v.name, status: "running" });
          }
          if (event === "tool_result" && data) {
            const v = JSON.parse(data);
            onEvent({ type: "tool_result", name: v.name, status: "done" });
          }
        }
        if (done) break;
      }
    } finally {
      reader.releaseLock();
    }
  })();

  return { promise, cancel };
}

function readStreamPayload(payload: string) {
  try {
    const value: unknown = JSON.parse(payload);
    if (typeof value === "object" && value !== null && "content" in value &&
      typeof (value as { content: unknown }).content === "string") {
      return (value as { content: string }).content;
    }
  } catch { /* fallthrough */ }
  return payload;
}
