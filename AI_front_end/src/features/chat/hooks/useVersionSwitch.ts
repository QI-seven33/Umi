import { useCallback } from "react";

import { useChatStore } from "../../../store/chatStore";
import type { MessageVersion } from "../../../types";
import { API_BASE } from "../../../utils/constants";
import { mapHistoryMessages } from "../utils/message";

export type UseVersionSwitchOptions = {
  streaming: boolean;
  reloadHistory: (threadId: string) => Promise<void>;
  fetchVersions: (threadId: string) => Promise<Record<string, MessageVersion[]>>;
};

export function useVersionSwitch({
  streaming,
  reloadHistory,
  fetchVersions,
}: UseVersionSwitchOptions) {
  const setActiveMessages = useChatStore((s) => s.setActiveMessages);

  const switchVersion = useCallback(
    async (threadId: string, versionGroupId: string, branchNum: number) => {
      if (streaming) return;
      if (!threadId || !versionGroupId || branchNum == null) {
        console.warn("[Umi] 无法切换版本：参数不完整", { threadId, versionGroupId, branchNum });
        return;
      }
      try {
        const res = await fetch(`${API_BASE}/api/chat/version/switch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            thread_id: threadId,
            version_group_id: versionGroupId,
            branch_num: branchNum,
          }),
        });
        if (!res.ok) {
          console.warn(`[Umi] 切换版本失败（${res.status}）`);
          return;
        }
        const json = await res.json();
        // 后端把切换后的完整消息一并返回，先归一化后直接渲染，避免中间态闪烁；
        // 随后用 reloadHistory 同步分页信息与 active_leaf_thread_id。
        const messages = mapHistoryMessages(json.data?.messages ?? []);
        const activeLeaf: string | undefined = json.data?.hidden_thread_id;
        setActiveMessages(threadId, messages, false, null, activeLeaf);
        await reloadHistory(threadId);
        await fetchVersions(threadId);
      } catch { /* silent */ }
    },
    [streaming, setActiveMessages, fetchVersions, reloadHistory],
  );

  return { switchVersion };
}
