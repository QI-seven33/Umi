import type { StateCreator } from "zustand";

import type { ChatState, StreamingSlice } from "../types";

export const createStreamingSlice: StateCreator<ChatState, [], [], StreamingSlice> = (set) => ({
  streaming: false,

  setStreaming: (v) => set({ streaming: v }),
});
