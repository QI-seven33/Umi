# umi/compact_middleware.py
import contextvars
import logging
from langchain_core.messages import BaseMessage, SystemMessage
from langchain.agents.middleware import wrap_model_call
from umi.archive import archive_messages
from umi.message_utils import content_to_text
from deepseek_tokenizer import ds_token

logger = logging.getLogger(__name__)

# 由 service.init_agent_service 注入
_db_connection = None

# 当前请求的 thread 上下文，由 chat_stream 设置
# 存 (leaf_thread_id, main_thread_id)
_current_thread_ctx: contextvars.ContextVar[tuple | None] = contextvars.ContextVar(
    "current_thread_ctx", default=None
)

# 触发阈值与保留条数
KEEP_RECENT = 20
TRIGGER_TOKENS = 600_000
SUMMARY_PREFIX = "[历史对话摘要]\n"


def set_db_connection(connection):
    """由 service 层在启动时调用，注入 SQLite 连接。"""
    global _db_connection
    _db_connection = connection


def set_current_thread(leaf_thread_id: str, main_thread_id: str | None = None):
    """由 chat_stream 在调用 graph 前设置。"""
    _current_thread_ctx.set((leaf_thread_id, main_thread_id or leaf_thread_id))


def get_current_thread() -> tuple[str | None, str | None]:
    """中间件读取当前 thread 上下文，返回 (leaf, main)。"""
    ctx = _current_thread_ctx.get()
    if not ctx:
        return None, None
    return ctx


def _count_tokens(messages: list[BaseMessage]) -> int:
    """用 DeepSeek 官方 tokenizer 精确计算 token 数。"""
    total = 0
    for m in messages:
        text = content_to_text(m.content)
        total += len(ds_token.encode(text))
    return total


def _should_compact(messages: list[BaseMessage]) -> bool:
    if len(messages) <= KEEP_RECENT:
        return False
    return _count_tokens(messages) > TRIGGER_TOKENS


async def _summarize(model, old_messages: list[BaseMessage]) -> str:
    """用独立裸模型生成摘要，不经过 agent 的 middleware 链。"""
    lines = []
    for m in old_messages:
        if m.type == "human":
            role = "用户"
        elif m.type == "ai":
            role = "助手"
        else:
            role = m.type
        text = content_to_text(m.content)
        if text:
            lines.append(f"{role}: {text}")
    conversation = "\n".join(lines)

    prompt = (
        "请把下面这段对话压缩成一段简洁的摘要，"
        "保留关键事实、用户意图、已经给出的结论和未解决的问题。"
        "不要编造，不要添加评论，只输出摘要正文。\n\n"
        f"{conversation}"
    )
    resp = await model.ainvoke(
        [SystemMessage(content=prompt)],
        config={"callbacks": []},
    )
    return content_to_text(resp.content)


@wrap_model_call
async def compact_for_model_only(request, handler):
    """
    只对本次模型调用做上下文压缩。
    checkpoint 里的 state["messages"] 原封不动。
    """
    messages = list(request.messages or [])

    if not _should_compact(messages):
        return await handler(request)

    old_messages = messages[:-KEEP_RECENT]
    keep_messages = messages[-KEEP_RECENT:]

    # 1. 生成摘要（用独立裸模型，避免递归）
    from umi.llm import model as summarizer_model
    try:
        summary_text = await _summarize(summarizer_model, old_messages)
    except Exception:
        logger.exception("摘要生成失败，回退到完整历史")
        return await handler(request)

    # 2. 归档被压缩的旧消息（尽力而为）
    if _db_connection is not None:
        leaf_thread_id, main_thread_id = get_current_thread()
        thread_id = main_thread_id or leaf_thread_id
        if thread_id and leaf_thread_id:
            await archive_messages(
                _db_connection, thread_id, leaf_thread_id, old_messages
            )
        else:
            logger.warning("跳过归档: thread_id 或 leaf 为空")

    # 3. 构造发给模型的消息：摘要 + 近期消息
    summary_msg = SystemMessage(content=SUMMARY_PREFIX + summary_text)
    new_messages = [summary_msg] + keep_messages

    return await handler(request.override(messages=new_messages))
