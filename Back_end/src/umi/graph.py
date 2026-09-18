from langchain.agents import create_agent
from umi.state import OverAllState
from umi.llm import model, sys_msg
from langchain_core.messages import ToolMessage, SystemMessage
from langchain.agents.middleware import (
    after_model,
    wrap_tool_call,
    ToolCallLimitMiddleware,
    ModelCallLimitMiddleware
)
import logging
logger = logging.getLogger(__name__)


from umi.message_utils import content_to_text
from langchain.agents.structured_output import ToolStrategy
from umi.compact_middleware import compact_for_model_only
from deepseek_tokenizer import ds_token
from deepagents.middleware.summarization import SummarizationMiddleware
from deepagents.backends import FilesystemBackend
from pydantic import BaseModel, Field
from langgraph.graph import END, StateGraph, START
import asyncio
from langchain_core.messages import AIMessage, HumanMessage
from langchain.tools.tool_node import ToolCallRequest
from langgraph.prebuilt.tool_node import ToolNode
from umi.tools import deepseek_server_web_search
from langgraph.types import TimeoutPolicy, RetryPolicy, Command
from langgraph.errors import NodeError
from datetime import datetime
from langchain.agents.middleware import ToolRetryMiddleware, ModelRetryMiddleware

tools = [deepseek_server_web_search]

# class UmiResponse(BaseModel):
#     """Umi 的结构化回复"""
#     reply: str = Field(description="给用户的最终回复，遵循 Umi 的说话方式")
#     reasoning_summary: str = Field(description="简要说明本轮回答的依据，不展示给用户，供调试和审计")
#     sources: list[str] = Field(default_factory=list, description="引用的工具结果来源标识")

# * 把 state["messages"] 里的元素展开到新列表 并追加 AIMessage(content="请求异常")
def finalize(state: OverAllState) -> OverAllState:
    new_messages = [*state["messages"], AIMessage(content="请求异常")]
    return {"messages": new_messages}


def payment_error_handler(state: OverAllState, error: NodeError):
    print(f"节点 '{error.node}' 在重试后最终失败: {error.error}")
    return Command(
        update={"status": f"compensated: {error.error}"},
        goto="finalize",
    )


from langchain_core.messages import ToolMessage, HumanMessage, SystemMessage, AIMessage


def evaluate_node(state: OverAllState) -> OverAllState:
    """
    质量门禁：基于 ToolMessage.artifact 做确定性判断。
    """

    # state.get("messages", []) 安全取字段，没有就返回 []
    messages = state.get("messages", [])

    recent_tools = []
    # 从后往前遍历 messages 列表，找到最近的 ToolMessage 消息，直到遇到 HumanMessage
    for msg in reversed(messages):
        if isinstance(msg, HumanMessage):
            break
        # "artifact" 在 LangChain 里，它指：工具执行时产生的、给程序看的结构化数据，和给模型看的 content 分开
        if isinstance(msg, ToolMessage) and getattr(msg, "artifact", None): # getattr( 对象, "属性名", 默认值 )
            recent_tools.append(msg)
    # 反转术式
    recent_tools.reverse()
    # 安全取 artifact 的 evidence_status 属性，没有就 None
    artifacts = [
        getattr(tool_message.artifact, "evidence_status", None)
        for tool_message in recent_tools
    ]
    logger.debug(
        f"evaluate_node: recent_tools={len(recent_tools)}, "
        f"artifacts={artifacts}, retry_count={state.get('retry_count', 0)}"
    )

    if not recent_tools:
        # 用 state.get("retry_count", 0) 安全取值，没有就 0
        return {"status": "sufficient", "retry_count": state.get("retry_count", 0)}

    # 最新那条工具消息的 artifact
    artifact = recent_tools[-1].artifact

    if artifact.execution_status == "failed":
        return {
            "status": "insufficient",
            "retry_count": state.get("retry_count", 0),
            "messages": [SystemMessage(
                content="搜索工具执行失败。请告知用户当前无法完成搜索。"
            )],
        }

    if artifact.evidence_status == "empty":
        return {
            "status": "insufficient",
            "retry_count": state.get("retry_count", 0),
            "messages": [SystemMessage(
                content="搜索未找到结果。请换一个关键词重试。"
            )],
        }

    return {"status": "sufficient", "retry_count": state.get("retry_count", 0)}

# 是重试计数器节点
def increment_node(state):
    return {"retry_count": state.get("retry_count", 0) + 1}


def route_after_evaluate(state):
    if state.get("retry_count", 0) >= 2:
        return "__end__"
    if state.get("status") == "insufficient":
        # 跳转到重试计数器节点
        return "increment_node"
    return "__end__"

# @after_model 是 LangChain 的中间件装饰器，把函数注册成"模型调用之后"执行的钩子函数
@after_model
def inject_timestamp(state, runtime):
    """给最新 AIMessage 注入时间戳，并继承本轮回复的版本元数据。"""
    messages = state.get("messages", [])
    if messages:
        last = messages[-1]
        if isinstance(last, AIMessage):
            # last.additional_kwargs AIMessage 的附加字段字典
            if not last.additional_kwargs.get("ts"):
                last.additional_kwargs["ts"] = datetime.now().isoformat() # .isoformat()	转 ISO 8601 字符串
            for message in reversed(messages[:-1]):
                if not isinstance(message, HumanMessage):
                    # continue 是 Python 循环里的控制流关键字，作用是跳过本次循环剩下的代码，直接进入下一次循环
                    continue
                reply_group_id = message.additional_kwargs.get("reply_version_group_id") # 从字典里取 reply_version_group_id 这个键的值
                if reply_group_id:
                    last.additional_kwargs["version_group_id"] = reply_group_id
                    last.additional_kwargs["version_num"] = int(
                        message.additional_kwargs.get("reply_version_num", 0)
                    )
                break
    return None


@wrap_tool_call
async def tool_timeout_middleware(request: ToolCallRequest, handler):
    """给工具调用加硬超时，超时后抛 TimeoutError 触发后续重试"""
    try:
        # wait_for 是 asyncio 的超时包装器
        # 它等待 coro 完成，但最多等 timeout 秒 , 如果超时，抛出 asyncio.TimeoutError 异常
        # 如果完成，返回协程或 Future 的结果
        return await asyncio.wait_for(
            handler(request),
            timeout=60.0
        )
    except asyncio.TimeoutError:
        raise TimeoutError(
            f"工具 '{request.tool_call['name']}' 执行超过 60 秒"
        )


Umi_agent = create_agent(
    model=model,
    tools=tools,
    system_prompt=sys_msg,
    # response_format=ToolStrategy(UmiResponse, force_tool_choice=False),
    middleware=[
        tool_timeout_middleware,
        ToolRetryMiddleware(
            max_retries=2,
            on_failure="error",
            tools=["deepseek_server_web_search"],
            retry_on=(TimeoutError, ConnectionError),
        ),
        ModelRetryMiddleware(
            max_retries=3,
            backoff_factor=2.0,
            initial_delay=1.0,
        ),
        ToolCallLimitMiddleware(
            tool_name="deepseek_server_web_search",
            run_limit=5,
            exit_behavior="end"
        ),
        ModelCallLimitMiddleware(
            run_limit=8,
            exit_behavior="end"
        ),
        compact_for_model_only,
        inject_timestamp,
    ]
)


def build_raw_graph():
    builder = StateGraph(state_schema=OverAllState)
    builder.add_node(
        "agent_node",
        Umi_agent,
        error_handler=payment_error_handler,
    )
    builder.add_node("finalize", finalize)
    builder.add_node("evaluate_node", evaluate_node)
    builder.add_node("increment_node", increment_node)

    builder.add_edge(START, "agent_node")
    builder.add_edge("agent_node", "evaluate_node")
    builder.add_conditional_edges(
        "evaluate_node",
        route_after_evaluate,
        {
            "increment_node": "increment_node",
            "__end__": END,
        }
    )
    builder.add_edge("increment_node", "agent_node")
    builder.add_edge("finalize", END)

    return builder
