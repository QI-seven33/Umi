from typing import TypedDict, Annotated
from langchain_core.messages import BaseMessage
from langgraph.graph import add_messages


class OverAllState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    status: str
    retry_count: int  # 重试次数
    last_tool_result: str | None  # 上一轮工具返回的原始内容
    # 新增：被压缩消息的归档区，不参与 messages 的 reducer
    compacted_messages: list[BaseMessage]