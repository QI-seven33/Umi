import type { Message } from "../../../types";
import { makeId } from "../../../utils/file";

export function mapHistoryMessages(raw: Array<{
  messageId: string | null; versionGroupId: string | null; versionNum: number;
  role: "user" | "assistant"; text: string; createdAt: number | null;
}>): Message[] {
  return raw.map((m) => ({
    id: m.messageId || `tmp-${makeId()}`,
    messageId: m.messageId ?? "",
    versionGroupId: m.versionGroupId ?? "",
    versionNum: m.versionNum ?? 0,
    role: m.role,
    text: m.text,
    createdAt: m.createdAt,
  }));
}
