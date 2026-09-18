# umi/compact_middleware.py

import contextvars
import logging
from langchain_core.messages import BaseMessage, SystemMessage
from langchain.agents.middleware import wrap_model_call
from umi.archive import archive_messages
from umi.message_utils import content_to_text
from deepseek_tokenizer import ds_token

logger = logging.getLogger(__name__)

#  # 数据库连接，由 外部service.init_agent_service 注入
_db_connection = None

# 当前请求上下文，由 chat_stream 设置。
# 存 (leaf_thread_id, main_thread_id, workspace_id, workspace_path)

# contextvars.ContextVar 这是 Python 的上下文变量，专门解决异步并发下的"线程/任务局部变量"问题
# contextvars 是 Python 标准库里的一个模块 可以把它理解成一个"工具箱"，里面装着几个工具
# ContextVar —— 上下文变量类 | Context —— 上下文对象 | copy_context() —— 复制当前上下文的函数
# 变量名: 类型
# 这个 ContextVar 里存的值，要么是一个 4 元组，要么是 None
# tuple[str, str, str, str | None] —— 前 3 个必填字符串，第 4 个可空
_current_thread_ctx: contextvars.ContextVar[
    tuple[str, str, str, str | None] | None
] = contextvars.ContextVar(
    "current_thread_ctx", default=None # 值 None 表示：当这个 ContextVar 在当前上下文里从没被 .set() 过时，.get() 返回 None
)

# 触发阈值与保留条数
KEEP_RECENT = 20
TRIGGER_TOKENS = 600_000
SUMMARY_PREFIX = "[历史对话摘要]\n"


# 启动时调一次，把数据库连接塞进全局变量
def set_db_connection(connection):
    """由 service 层在启动时调用，注入 SQLite 连接。"""
    global _db_connection # # 声明修改的是模块级变量
    _db_connection = connection


# 把当前请求的 4 个身份信息写进 ContextVar
# 每个请求调用一次，写的是当前 Task 自己的副本，不会影响别的请求
def set_current_thread(
    leaf_thread_id: str,
    main_thread_id: str,
    workspace_id: str,
    workspace_path: str | None,
):
    """由 chat_stream 在调用 graph 前设置。"""
    _current_thread_ctx.set(
        (leaf_thread_id, main_thread_id, workspace_id, workspace_path)
    )

# 读 ContextVar
# 如果没设置（None 或空元组），返回 4 个 None，让调用方不用处理异常
# 否则返回元组
def get_current_thread() -> tuple[
    str | None, str | None, str | None, str | None
]:
    """返回 (leaf, main, workspace_id, workspace_path)。"""
    ctx = _current_thread_ctx.get()
    if not ctx:
        return None, None, None, None
    return ctx


def _count_tokens(messages: list[BaseMessage]) -> int:
    """用 DeepSeek 官方 tokenizer 精确计算 token 数。"""
    total = 0
    for m in messages:
        # 把每条消息的 content 转成纯文本，再用 DeepSeek 分词器编码，编码后的长度就是 token 数
        text = content_to_text(m.content)
        # 累加得到总 token
        total += len(ds_token.encode(text))
    return total

# 两个条件都满足才压缩
def _should_compact(messages: list[BaseMessage]) -> bool:
    if len(messages) <= KEEP_RECENT:
        return False
    return _count_tokens(messages) > TRIGGER_TOKENS

# 把旧消息拼成 角色: 内容 的文本
async def _summarize(model, old_messages: list[BaseMessage]) -> str:
    """用独立裸模型生成摘要，不经过 agent 的 middleware 链。"""
    lines = []
    for m in old_messages:
        if m.type == "human":
            role = "用户"
        elif m.type == "ai":
            role = "助手"
        else:
            role = m.type # else 分支把未知类型原样当作角色名，是一种兜底（fallback）策略
        text = content_to_text(m.content)
        if text:
            lines.append(f"{role}: {text}")
    # 用换行拼接成完整对话
    conversation = "\n".join(lines)

    prompt = (
        "请把下面这段对话压缩成一段简洁的摘要，"
        "保留关键事实、用户意图、已经给出的结论和未解决的问题。"
        "不要编造，不要添加评论，只输出摘要正文。\n\n"
        f"{conversation}"
    )
    #  # 异步调用裸模型：只发一条 SystemMessage，callbacks 置空以绕开中间件链
    resp = await model.ainvoke(
        [SystemMessage(content=prompt)],
        config={"callbacks": []},
    )
    return content_to_text(resp.content)

# 把它注册成模型调用 middleware , 签名固定 (request, handler)
@wrap_model_call
async def compact_for_model_only(request, handler):
    """
    只对本次模型调用做上下文压缩。
    checkpoint 里的 state["messages"] 原封不动。
    """
    messages = list(request.messages or []) # 把请求里的消息复制一份，避免修改原列表 同时用 or 短路求值，避免空指针异常
    # 不满足 → 直接放行
    if not _should_compact(messages):
        return await handler(request)

    old_messages = messages[:-KEEP_RECENT] # 除了最近 20 条，其余是要被压缩的旧消息
    keep_messages = messages[-KEEP_RECENT:] # 最近 20 条原样保留

    # 1. 生成摘要（用独立裸模型，避免递归）
    from umi.llm import model as summarizer_model
    try:
        # 调用上面的 _summarize 函数生成摘要
        summary_text = await _summarize(summarizer_model, old_messages)
    except Exception:
        logger.exception("摘要生成失败，回退到完整历史")
        return await handler(request)

    # 2. 归档被压缩的旧消息（尽力而为）
    if _db_connection is not None:
        # 调用上面的 get_current_thread 函数获取当前请求的 4 个身份信息
        # _ , _ , workspace_id, workspace_path 两个参数我们不使用，所以用 _ 表示忽略
        leaf_thread_id, main_thread_id, _, _ = get_current_thread()
        thread_id = main_thread_id or leaf_thread_id
        if thread_id and leaf_thread_id:
            # 调用archive_middleware.py 的 archive_messages 函数归档被压缩的旧消息
            await archive_messages(
                _db_connection, thread_id, leaf_thread_id, old_messages
            )
        else:
            logger.warning("跳过归档: thread_id 或 leaf 为空")

    # 3. 构造发给模型的消息：摘要 + 近期消息
    summary_msg = SystemMessage(content=SUMMARY_PREFIX + summary_text)
    new_messages = [summary_msg] + keep_messages

    return await handler(request.override(messages=new_messages))
