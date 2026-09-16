# service.py
import re
import asyncio
import sqlite3
from uuid import uuid4
from typing import List, Dict, Any
from umi.graph import build_raw_graph
from umi.store import close_sqlite_store, get_sqlite_checkpointer
from langchain_core.messages import BaseMessage, AIMessage, HumanMessage
from umi.exceptions import CustomExceptionCode
from datetime import datetime
from api_exception import APIException
import logging
from umi.compact_middleware import set_db_connection
from umi.message_utils import content_to_text

logger = logging.getLogger(__name__)

# 活跃的流式对话任务注册表，供 /api/chat/stop 取消
_active_tasks: dict[str, asyncio.Task] = {}

# 全局单例，存储 LangGraph 编译后的执行图和 SQLite 连接
# 在 FastAPI lifespan 的 startup 阶段初始化，shutdown 阶段清理
graph = None
db_connection = None
checkpointer = None


async def init_agent_service():
    """服务启动钩子：初始化 graph 和 SQLite。"""
    global graph, db_connection, checkpointer
    checkpointer, connection = await get_sqlite_checkpointer()
    db_connection = connection
    set_db_connection(connection)
    builder = build_raw_graph()
    graph = builder.compile(checkpointer=checkpointer)
    print("Agent服务初始化完成")


async def _ensure_graph():
    """
    防御性检查：确保 graph 已初始化。
    FastAPI lifespan 已保证 init_agent_service() 在请求到达前执行完毕，
    此函数主要防止编码错误或未来架构变更导致的未初始化访问。
    """
    global graph
    if graph is None:
        raise RuntimeError("Agent graph未完成初始化，请检查FastAPI lifespan启动流程")
    return graph


async def shutdown_agent_service():
    """服务关闭钩子：释放 SQLite 连接。"""
    global graph, db_connection, checkpointer
    if db_connection is not None:
        await close_sqlite_store()
        graph = None
        db_connection = None
        checkpointer = None
        set_db_connection(None)
        print("SQLite连接已关闭")


# ─────────────────────────────────────────────────────────────
# 主会话元数据：active_leaf_thread_id 读写
# ─────────────────────────────────────────────────────────────

async def _get_active_leaf_thread(main_thread_id: str) -> str:
    """
    读主会话当前活跃的 leaf thread_id。
    没有记录或为 NULL 时，返回主 thread 自己。
    """
    async with db_connection.execute(
        "SELECT active_leaf_thread_id FROM umi_threads WHERE thread_id = ?",
        (main_thread_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if row and row["active_leaf_thread_id"]:
        return row["active_leaf_thread_id"]
    return main_thread_id


async def _set_active_leaf_thread(main_thread_id: str, leaf_thread_id: str) -> None:
    """更新主会话的 active_leaf_thread_id。"""
    await db_connection.execute(
        """
        UPDATE umi_threads
        SET active_leaf_thread_id = ?, updated_at = datetime('now')
        WHERE thread_id = ?
        """,
        (leaf_thread_id, main_thread_id),
    )
    await db_connection.commit()


# ─────────────────────────────────────────────────────────────
# 内容与时间归一化
# ─────────────────────────────────────────────────────────────

# def _content_to_text(content) -> str:
#     """
#     把 LangChain 1.x 的 content 归一化成纯字符串。
#     content 可能是：
#       - str：旧格式，直接用
#       - list[dict]：新格式，如 [{"type": "text", "text": "...", "index": 0}]
#     """
#     if isinstance(content, str):
#         return content
#     if isinstance(content, list):
#         parts = []
#         for block in content:
#             if isinstance(block, str):
#                 parts.append(block)
#             elif isinstance(block, dict):
#                 if block.get("type") == "text" and "text" in block:
#                     parts.append(block["text"])
#         return "".join(parts)
#     return str(content) if content else ""


def _to_millis(ts):
    """把 ISO 字符串或数字时间戳统一转成毫秒时间戳。"""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        return int(ts * 1000) if ts < 1e12 else int(ts)
    if isinstance(ts, str):
        try:
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except Exception:
            return None
    return None


def _msg_id(msg) -> str | None:
    """取 LangChain message 的物理 ID；读取时绝不临时生成 ID。"""
    mid = getattr(msg, "id", None)
    return str(mid) if mid else None


def _version_group_id(msg) -> str | None:
    """取跨 thread 稳定的版本组 ID，兼容尚无元数据的旧消息。"""
    group_id = msg.additional_kwargs.get("version_group_id")
    return str(group_id) if group_id else _msg_id(msg)


def _version_num(msg) -> int:
    """取消息在版本组中的编号；旧消息视为原版 0。"""
    value = msg.additional_kwargs.get("version_num", 0)
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


# ─────────────────────────────────────────────────────────────
# 扁平化消息（用 LangChain msg.id 做稳定 ID）
# ─────────────────────────────────────────────────────────────

def _flatten_messages(raw_messages: list) -> list[dict]:
    """
    把 LangGraph 的原始消息数组扁平化成前端可用的消息列表。
    只保留 human 和「有 content 的 ai」两类，跳过纯工具调用消息。
    """
    all_messages = []
    for msg in raw_messages:
        if msg.type == "human":
            all_messages.append({
                "messageId": _msg_id(msg),
                "versionGroupId": _version_group_id(msg),
                "versionNum": _version_num(msg),
                "role": "user",
                "text": content_to_text(msg.content),
                "createdAt": _to_millis(msg.additional_kwargs.get("ts")),
            })
        elif msg.type == "ai" and msg.content:
            text = content_to_text(msg.content)
            if not text:
                continue
            all_messages.append({
                "messageId": _msg_id(msg),
                "versionGroupId": _version_group_id(msg),
                "versionNum": _version_num(msg),
                "role": "assistant",
                "text": text,
                "createdAt": _to_millis(msg.additional_kwargs.get("ts")),
            })
    return all_messages


async def _read_thread_messages(thread_id: str) -> list:
    """读指定 thread 的原始 LangChain messages。"""
    graph_instance = await _ensure_graph()
    config = {"configurable": {"thread_id": thread_id}}
    state = await graph_instance.aget_state(config)
    if not state or not state.values:
        return []
    return state.values.get("messages", [])


async def get_messages_from_thread(thread_id: str) -> list[dict]:
    """读取指定 thread 的全部扁平化消息（不分页）。"""
    raw = await _read_thread_messages(thread_id)
    return _flatten_messages(raw)


# ─────────────────────────────────────────────────────────────
# 消息定位辅助：按 message_id 找下标 / 找前一条 human
# ─────────────────────────────────────────────────────────────

def _find_index_by_message_id(messages: list, message_id: str) -> int:
    """在原始 messages 里按 msg.id 找下标，找不到返回 -1。"""
    for i, m in enumerate(messages):
        mid = _msg_id(m)
        if mid and mid == message_id:
            return i
    return -1


def _find_previous_human_index(messages: list, start: int) -> int:
    """从 start（含）往前找最近一条 human 消息的索引，找不到返回 -1。"""
    for i in range(start, -1, -1):
        if messages[i].type == "human":
            return i
    return -1


def _truncate_before_index(messages: list, cut_index: int) -> list:
    """
    返回一个截断后的消息列表，保留 messages[:cut_index]。
    做「边界对齐」：如果末尾是孤立的 ToolMessage（前面没有对应 tool_calls），去掉。
    """
    if cut_index <= 0:
        return []
    truncated = list(messages[:cut_index])
    while truncated and truncated[-1].type == "tool":
        truncated.pop()
    return truncated


# ─────────────────────────────────────────────────────────────
# 版本分支：创建 / 读取 / 切换
# ─────────────────────────────────────────────────────────────

async def _next_branch_num(thread_id: str, version_group_id: str) -> int:
    """取该版本组已用过的最大 branch_num + 1。"""
    async with db_connection.execute(
        """
        SELECT COALESCE(MAX(branch_num), 0) AS mx
        FROM umi_message_versions
        WHERE thread_id = ?
          AND version_group_id = ?
        """,
        (thread_id, version_group_id),
    ) as cursor:
        row = await cursor.fetchone()
    return (row["mx"] if row and row["mx"] else 0) + 1


async def _ensure_base_version(
        thread_id: str,
        version_group_id: str,
        source_leaf_thread_id: str,
) -> None:
    """首次分叉某个消息位置时，登记它当前所在 leaf 为原版 0。"""
    await db_connection.execute(
        """
        INSERT INTO umi_message_versions
            (thread_id, version_group_id, branch_num, hidden_thread_id, kind)
        VALUES (?, ?, 0, ?, 'root')
        ON CONFLICT (thread_id, version_group_id, branch_num) DO NOTHING
        """,
        (thread_id, version_group_id, source_leaf_thread_id),
    )
    await db_connection.commit()


async def _allocate_branch_num_with_retry(
        thread_id: str,
        version_group_id: str,
        hidden_thread_id_factory,
        kind: str,
        max_retries: int = 3,
) -> tuple[int, str]:
    """
    在唯一约束保护下分配 branch_num。
    冲突时重新计算，最多重试 max_retries 次。
    """
    for attempt in range(max_retries):
        branch_num = await _next_branch_num(thread_id, version_group_id)
        hidden_thread_id = hidden_thread_id_factory(branch_num)
        try:
            await db_connection.execute(
                """
                INSERT INTO umi_message_versions
                    (thread_id, version_group_id, branch_num, hidden_thread_id, kind)
                VALUES (?, ?, ?, ?, ?)
                """,
                (thread_id, version_group_id, branch_num, hidden_thread_id, kind),
            )
            await db_connection.commit()
            return branch_num, hidden_thread_id
        except sqlite3.IntegrityError:
            await db_connection.rollback()
            continue
    raise RuntimeError(
        f"branch_num 分配失败，重试 {max_retries} 次仍冲突: "
        f"thread={thread_id}, group={version_group_id}"
    )


async def create_version_branch(
        thread_id: str,
        target_message_id: str,
        new_content: str | None,
        kind: str,  # 'edit' | 'regenerate'
) -> dict:
    """
    从当前 active leaf thread 分叉一个新分支。

    - target_message_id 是 active leaf 中被点击消息的物理 msg.id。
    - version_group_id 来自消息元数据，跨分支保持稳定。
    - kind == 'edit': 用 new_content 替换 anchor 对应的 human 内容
    - kind == 'regenerate': 保持 human 内容不变，重新生成它后面的 AI

    返回新 leaf 以及重放本轮所需的版本元数据。
    """
    graph_instance = await _ensure_graph()

    # 1. 从当前 active leaf thread 读 messages
    active_leaf = await _get_active_leaf_thread(thread_id)
    messages = await _read_thread_messages(active_leaf)
    if not messages:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )

    # 2. 用物理消息 ID 定位本次操作目标
    anchor_index = _find_index_by_message_id(messages, target_message_id)
    if anchor_index < 0:
        raise APIException(
            error_code=CustomExceptionCode.INVALID_ARGUMENT,
            http_status_code=400,
        )

    # 3. 解析 fork 点与 query
    if kind == "edit":
        # anchor 必须是 human；fork 到该 human 之前
        if messages[anchor_index].type != "human":
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        human_index = anchor_index
        if not new_content or not new_content.strip():
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        query = new_content.strip()
    else:
        # regenerate: anchor 是 AI；fork 到它对应的 human 之前
        if messages[anchor_index].type != "ai":
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        human_index = _find_previous_human_index(messages, anchor_index)
        if human_index < 0:
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        query = content_to_text(messages[human_index].content)

    anchor_group_id = _version_group_id(messages[anchor_index])
    human_group_id = _version_group_id(messages[human_index])
    if not anchor_group_id or not human_group_id:
        raise APIException(
            error_code=CustomExceptionCode.INVALID_ARGUMENT,
            http_status_code=400,
        )

    truncated = _truncate_before_index(messages, human_index)

    # 4. 每个消息位置都独立登记原版 0，再分配新版本号
    await _ensure_base_version(thread_id, anchor_group_id, active_leaf)
    branch_num = await _next_branch_num(thread_id, anchor_group_id)

    if kind == "edit":
        replay_human_group_id = anchor_group_id
        replay_human_version_num = branch_num
        replay_assistant_group_id = str(uuid4())
        replay_assistant_version_num = 0
    else:
        replay_human_group_id = human_group_id
        replay_human_version_num = _version_num(messages[human_index])
        replay_assistant_group_id = anchor_group_id
        replay_assistant_version_num = branch_num

    def _make_hidden_tid(bn: int) -> str:
        return f"{thread_id}_b{bn}_{uuid4().hex[:6]}"

        # 5. 先抢 branch_num（唯一约束保护并发安全）

    branch_num, hidden_thread_id = await _allocate_branch_num_with_retry(
        thread_id=thread_id,
        version_group_id=anchor_group_id,
        hidden_thread_id_factory=_make_hidden_tid,
        kind=kind,
    )

    # 6. 再创建 hidden thread 的 checkpoint
    new_config = {"configurable": {"thread_id": hidden_thread_id}}
    try:
        await graph_instance.aupdate_state(new_config, {"messages": truncated})
    except Exception:
        # checkpoint 创建失败，回滚版本表记录，避免孤立
        await db_connection.execute(
            """
            DELETE
            FROM umi_message_versions
            WHERE thread_id = ?
              AND version_group_id = ?
              AND branch_num = ?
            """,
            (thread_id, anchor_group_id, branch_num),
        )
        await db_connection.commit()
        raise

    # 7. 把主会话的 active leaf 指向新分支
    await _set_active_leaf_thread(thread_id, hidden_thread_id)

    return {
        "thread_id": hidden_thread_id,
        "branch_num": branch_num,
        "query": query,
        "version_group_id": anchor_group_id,
        "human_version_group_id": replay_human_group_id,
        "human_version_num": replay_human_version_num,
        "assistant_version_group_id": replay_assistant_group_id,
        "assistant_version_num": replay_assistant_version_num,
    }


async def get_message_versions(thread_id: str) -> dict[str, list[dict]]:
    """
    返回 { version_group_id: [版本列表] }。
    版本列表按 branch_num 数值排序（v0 是 root，v2 在 v10 前面）。
    """
    async with db_connection.execute(
        """
        SELECT version_group_id, branch_num, hidden_thread_id, kind
        FROM umi_message_versions
        WHERE thread_id = ?
        ORDER BY version_group_id, branch_num
        """,
        (thread_id,),
    ) as cursor:
        rows = await cursor.fetchall()

    result: dict[str, list[dict]] = {}
    for r in rows:
        key = r["version_group_id"]
        if key not in result:
            result[key] = []
        result[key].append({
            "branch_num": r["branch_num"],
            "hidden_thread_id": r["hidden_thread_id"],
            "kind": r["kind"],
        })
    return result


async def switch_active_version(
        thread_id: str,
        version_group_id: str,
        branch_num: int,
) -> str:
    """
    切换当前会话的 active leaf 到指定版本，返回该版本的 hidden_thread_id。
    """
    async with db_connection.execute(
        """
        SELECT hidden_thread_id
        FROM umi_message_versions
        WHERE thread_id = ?
          AND version_group_id = ?
          AND branch_num = ?
        """,
        (thread_id, version_group_id, branch_num),
    ) as cursor:
        row = await cursor.fetchone()

    if not row:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )

    hidden = row["hidden_thread_id"]
    await _set_active_leaf_thread(thread_id, hidden)
    return hidden


# ─────────────────────────────────────────────────────────────
# 分页历史
# ─────────────────────────────────────────────────────────────

async def get_conversation_messages_paginated(
        thread_id: str,
        limit: int = 20,
        before: int | None = None,
) -> dict:
    """获取指定会话当前 active leaf 的分页消息列表。"""
    active_leaf = await _get_active_leaf_thread(thread_id)
    raw_messages = await _read_thread_messages(active_leaf)
    if not raw_messages:
        return {
            "messages": [],
            "has_more": False,
            "next_cursor": None,
            "total": 0,
            "active_leaf_thread_id": active_leaf,
        }

    all_messages = _flatten_messages(raw_messages)
    total = len(all_messages)

    if before is None:
        end = total
    else:
        end = 0 if before <= 0 else min(before, total)

    start = max(0, end - limit)
    page = all_messages[start:end]
    has_more = start > 0
    next_cursor = start if has_more else None

    logger.info(
        f"分页调试: thread_id={thread_id}, active_leaf={active_leaf}, "
        f"raw_len={len(raw_messages)}, all_len={len(all_messages)}, "
        f"before={before}, start={start}, end={end}"
    )
    return {
        "messages": page,
        "has_more": has_more,
        "next_cursor": next_cursor,
        "total": total,
        "active_leaf_thread_id": active_leaf,
    }


# ─────────────────────────────────────────────────────────────
# 会话 CRUD
# ─────────────────────────────────────────────────────────────

async def chat_stream(
        user_query: str,
        thread_id: str,
        human_version_group_id: str | None = None,
        human_version_num: int = 0,
        assistant_version_group_id: str | None = None,
        assistant_version_num: int = 0,
):
    """
    流式对话。
    thread_id 现在是「当前 active leaf thread」，由 API 层决定。
    普通发送：active leaf = 主 thread 或某个 hidden thread。
    """
    from umi.compact_middleware import set_current_thread

    # 解析主 thread：hidden thread 走 _b\d+_ 后缀
    is_hidden = "_b" in thread_id and re.search(r"_b\d+_", thread_id) is not None
    if is_hidden:
        main_thread_id = re.split(r"_b\d+_", thread_id)[0]
    else:
        main_thread_id = thread_id

    # 设置 thread 上下文，供 compact 中间件归档使用
    set_current_thread(thread_id, main_thread_id)

    # 登记 umi_threads：主 thread 才写 title，hidden 只更新 updated_at
    if not is_hidden:
        await db_connection.execute(
            """
            INSERT INTO umi_threads (thread_id, title, updated_at)
            VALUES (?, ?, datetime('now'))
            ON CONFLICT (thread_id) DO UPDATE SET updated_at = datetime('now')
            """,
            (thread_id, user_query[:30]),
        )
    else:
        await db_connection.execute(
            "UPDATE umi_threads SET updated_at = datetime('now') WHERE thread_id = ?",
            (main_thread_id,),
        )
    await db_connection.commit()

    graph_instance = await _ensure_graph()
    config = {"configurable": {"thread_id": thread_id}}
    human_group_id = human_version_group_id or str(uuid4())
    assistant_group_id = assistant_version_group_id or str(uuid4())
    input_data = {
        "messages": [
            HumanMessage(
                content=user_query,
                additional_kwargs={
                    "version_group_id": human_group_id,
                    "version_num": human_version_num,
                    "reply_version_group_id": assistant_group_id,
                    "reply_version_num": assistant_version_num,
                    "ts": datetime.now().isoformat(),
                },
            )
        ],
        "retry_count": 0,  # 每个新请求重置
    }

    accumulated_text = ""
    current_task = asyncio.current_task()
    if current_task:
        _active_tasks[thread_id] = current_task

    try:
        async for event in graph_instance.astream_events(
                input_data, config=config, version="v2"
        ):
            kind = event["event"]
            if kind == "on_chat_model_stream":
                chunk = event["data"]["chunk"]
                if chunk.content:
                    accumulated_text += chunk.content
                    yield {"type": "text", "content": chunk.content}
            elif kind == "on_tool_start":
                yield {"type": "tool_call", "name": event["name"], "status": "running"}
            elif kind == "on_tool_end":
                yield {"type": "tool_result", "name": event["name"], "status": "done"}
    except asyncio.CancelledError:
        if accumulated_text:
            try:
                await asyncio.shield(
                    graph_instance.aupdate_state(
                        config,
                        {"messages": [AIMessage(
                            content=accumulated_text,
                            additional_kwargs={
                                "ts": datetime.now().isoformat(),
                                "version_group_id": assistant_group_id,
                                "version_num": assistant_version_num,
                            },
                        )]},
                    )
                )
            except Exception:
                logger.exception("中断内容写回检查点失败")
        raise
    except Exception as e:
        raise APIException(
            error_code=CustomExceptionCode.LLM_SERVICE_ERROR,
            http_status_code=503,
        ) from e
    finally:
        _active_tasks.pop(thread_id, None)


async def chat_invoke(user_query: str, thread_id: str):
    try:
        graph_instance = await _ensure_graph()
        config = {"configurable": {"thread_id": thread_id}}
        return await graph_instance.ainvoke(
            {"messages": [("user", user_query)]}, config=config
        )
    except Exception as e:
        raise APIException(
            error_code=CustomExceptionCode.LLM_SERVICE_ERROR,
            http_status_code=503,
        ) from e


async def delete_conversation_thread(thread_id: str):
    """
    删除主会话：删主 thread、所有 hidden thread 的检查点、版本表记录、主会话元数据。
    """
    global checkpointer, db_connection
    try:
        if checkpointer is None:
            raise RuntimeError("Checkpointer 未初始化")

        # 收集所有相关 thread_id
        async with db_connection.execute(
            "SELECT hidden_thread_id FROM umi_message_versions WHERE thread_id = ?",
            (thread_id,),
        ) as cursor:
            hidden_rows = await cursor.fetchall()

        for r in hidden_rows:
            await checkpointer.adelete_thread(r["hidden_thread_id"])
        await checkpointer.adelete_thread(thread_id)

        await db_connection.execute(
            "DELETE FROM umi_message_versions WHERE thread_id = ?", (thread_id,)
        )
        await db_connection.execute(
            "DELETE FROM umi_threads WHERE thread_id = ?", (thread_id,)
        )
        await db_connection.commit()
    except Exception as e:
        if "not found" in str(e).lower():
            return
        raise APIException(
            error_code=CustomExceptionCode.THREAD_DELETE_FAILED,
            http_status_code=500,
        ) from e


async def list_conversations() -> list[dict]:
    """查询所有已激活的会话，按最近活跃排序。"""
    async with db_connection.execute(
        """
        SELECT thread_id, title, created_at, updated_at, pinned, active_leaf_thread_id
        FROM umi_threads
        ORDER BY pinned DESC, updated_at DESC
        """
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]


async def rename_conversation(thread_id: str, title: str) -> None:
    async with db_connection.execute(
        """
        UPDATE umi_threads
        SET title = ?, updated_at = datetime('now')
        WHERE thread_id = ?
        """,
        (title, thread_id),
    ) as cursor:
        rowcount = cursor.rowcount
    await db_connection.commit()
    if rowcount == 0:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )


async def set_conversation_pinned(thread_id: str, pinned: bool) -> None:
    async with db_connection.execute(
        "UPDATE umi_threads SET pinned = ? WHERE thread_id = ?",
        (pinned, thread_id),
    ) as cursor:
        rowcount = cursor.rowcount
    await db_connection.commit()
    if rowcount == 0:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )


async def get_conversation_message_count(thread_id: str) -> int:
    active_leaf = await _get_active_leaf_thread(thread_id)
    raw = await _read_thread_messages(active_leaf)
    return sum(
        1 for m in raw
        if m.type in ("human", "ai") and (m.type == "human" or m.content)
    )


# 搜索标题
async def search_conversations(keyword: str) -> list[dict]:
    """
    按标题模糊搜索会话。
    keyword 为空时返回全部，方便前端统一调用。
    """
    async with db_connection.execute(
        """
        SELECT thread_id, title, created_at, updated_at, pinned, active_leaf_thread_id
        FROM umi_threads
        WHERE title LIKE ?
        ORDER BY pinned DESC, updated_at DESC
        """,
        (f"%{keyword}%",),
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]
