# service.py
import re
import asyncio
import os
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
from agents import  Runner

# 模块级 logger，用模块名 service 做 logger 名
logger = logging.getLogger(__name__)

# 活跃的流式对话任务注册表，供 /api/chat/stop 取消
# 它是个"注册表"：谁在跑流式对话，就把自己的任务登记进来；跑完就注销登记
_active_tasks: dict[str, asyncio.Task] = {}

# 全局单例，存储 LangGraph 编译后的执行图和 SQLite 连接
# 在 FastAPI lifespan 的 startup 阶段初始化，shutdown 阶段清理
graph = None
db_connection = None
checkpointer = None


async def init_agent_service():
    """服务启动钩子：初始化 graph 和 SQLite。"""
    global graph, db_connection, checkpointer
    # await 等待协程执行完，拿到返回值
    checkpointer, connection = await get_sqlite_checkpointer()  #调用 store.py 中的 get_sqlite_checkpointer 函数
    db_connection = connection # 存到模块级变量 db_connection 中
    # 把数据库连接从 service 层注入到 compact_middleware 层，方便中间件使用数据库
    # 启动时调一次，把数据库连接塞进全局变量
    set_db_connection(connection)  # 调用 compact_middleware.py 中的 set_db_connection 函数
    builder = build_raw_graph()
    graph = builder.compile(checkpointer=checkpointer) # 给 LangGraph 用，编译执行图
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
        await close_sqlite_store() # 关闭 SQLite 连接
        graph = None
        db_connection = None
        checkpointer = None
        set_db_connection(None)
        print("SQLite连接已关闭")

# ─────────────────────────────────────────────────────────────
# 工作区
# ─────────────────────────────────────────────────────────────


async def create_workspace(name: str, path: str | None, mode: str) -> str:
    """创建工作区。Chat 的默认工作区只允许由数据库初始化。"""
    normalized_name = name.strip() # name.strip() 去掉名字首尾空格
    normalized_mode = mode.strip().lower() # mode.strip().lower() 去空格 + 转小写（统一格式）
    normalized_path = os.path.normpath(path.strip()) if path and path.strip() else None #如果 path 非空，去空格 + 规范化路径；否则 None
    # 短路求值：第一个为真，后面不执行
    if not normalized_name or normalized_mode != "work" or not normalized_path:
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=400,
        )
    # 生成一个随机 UUID（版本 4）
    workspace_id = str(uuid4()) # 返回 UUID 对象，如 UUID('550e8400-e29b-41d4-a716-446655440000')
    await db_connection.execute(
        """
        INSERT INTO umi_workspaces (workspace_id, name, path, mode)
        VALUES (?, ?, ?, ?)
        """,
        (workspace_id, normalized_name, normalized_path, normalized_mode),
    )
    # 为什么需要 commit
    # SQLite 的事务机制：默认自动开始事务（执行 INSERT 时隐式开始） 但不会自动提交
    # 必须显式 commit() 才真正写入磁盘
    await db_connection.commit()
    return workspace_id


async def get_workspace(workspace_id: str) -> dict:
    """ID 作为条件，查该工作区的完整信息"""
    # 进入时：调 __aenter__，返回的值赋给 cursor
    # 块结束时：调 __aexit__，自动关闭游标
    async with db_connection.execute(
        """
        SELECT workspace_id, name, path, mode, worktree_root, created_at
        FROM umi_workspaces
        WHERE workspace_id = ?
        """,
        (workspace_id,), # 加上逗号 表示 (workspace_id,) 是单元素元组
    ) as cursor:
        #  因为连接已设 row_factory = aiosqlite.Row < ==在store.py 中设置
        # 所以这里返回的 row 是一个 aiosqlite.Row 对象，而不是元组
        row = await cursor.fetchone() # cursor.fetchone()：取一行结果
    if not row:
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_NOT_FOUND,
            http_status_code=404,
        )
    return dict(row)

# 默认值 None，表示"不传就不过滤
# 调用方可传 mode="work"、mode="chat"，或不传
async def list_workspaces(mode: str | None = None) -> list[dict]:
    if mode is not None and mode not in ("chat", "work"):
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=400,
        )
    # 没有 WHERE，查所有工作区
    # params = () 空元组  因为没有 ? 占位符，参数为空
    if mode is None:
        query = """
            SELECT workspace_id, name, path, mode, worktree_root, created_at
            FROM umi_workspaces
            ORDER BY created_at, name
        """
        params = ()
    else:
        # 按 mode 过滤
        query = """
            SELECT workspace_id, name, path, mode, worktree_root, created_at
            FROM umi_workspaces
            WHERE mode = ?
            ORDER BY created_at, name
        """
        params = (mode,)
    async with db_connection.execute(query, params) as cursor:
        # fetchone返回 一行（Row 或 None）
        # fetchall返回 所有行（列表，每个元素是 Row 对象）
        rows = await cursor.fetchall()
    return [dict(row) for row in rows]


async def delete_workspace(workspace_id: str) -> None:
    """删除工作区数据库记录与 checkpoints，不接触其物理目录。"""
    global checkpointer
    if workspace_id == "default_chat":
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=400,
            description="default_chat 是系统工作区，不能删除。",
        )

    await get_workspace(workspace_id)
    async with db_connection.execute(
        "SELECT thread_id FROM umi_threads WHERE workspace_id = ?",
        (workspace_id,),
    ) as cursor:
        thread_rows = await cursor.fetchall() # fetchall()：取所有行 返回该工作区下的所有 thread_id

    try:
        for row in thread_rows:
            # 调用 delete_conversation_thread() 删除主会话：删主 thread、所有 hidden thread 的检查点、版本表记录、主会话元数据。
            await delete_conversation_thread(row["thread_id"])
        await db_connection.execute(
            "DELETE FROM umi_workspaces WHERE workspace_id = ?",
            (workspace_id,),
        )
        await db_connection.commit() # 提交事务，将所有操作写入磁盘 前面所有删除一起生效
    except APIException:
        raise
    except Exception as error:
        await db_connection.rollback() # 撤销当前事务里所有未提交的改动 “比如删了2个线程第3个失败→前2个也回滚” 要么全成功，要么全失败
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_DELETE_FAILED,
            http_status_code=500,
        ) from error


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
        row = await cursor.fetchone() # cursor.fetchone()：取一行结果
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
        # 根据数字大小，判断它是"秒"还是"毫秒"，统一转成毫秒
        # 1e12 是科学计数法 1e12 == 1000000000000    # 1 后面 12 个 0，共 13 位
        return int(ts * 1000) if ts < 1e12 else int(ts)
    if isinstance(ts, str):
        try:
            # str.replace(old, new) 语法 把字符串里所有 old 替换成 new
            # 这里把 "Z" 替换成 "+00:00"，因为 ISO 时间戳里 "Z" 表示 UTC 时间 "2026-09-17T14:30:00Z"
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except Exception:
            return None
    return None


def _msg_id(msg) -> str | None:
    """取 LangChain message 的物理 ID；读取时绝不临时生成 ID。"""
    # getattr(对象, "属性名", 默认值)：安全取属性
    # 安全取 msg.id 属性；没有就返回 None
    mid = getattr(msg, "id", None)
    return str(mid) if mid else None


def _version_group_id(msg) -> str | None:
    """取跨 thread 稳定的版本组 ID，兼容尚无元数据的旧消息。"""
    # msg.additional_kwargs：消息的附加字段字典
    # .get("version_group_id")：取该字段，没有返回 None
    group_id = msg.additional_kwargs.get("version_group_id")
    # 如果没有 version_group_id 字段，返回消息的物理 ID
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
                "text": content_to_text(msg.content), #调用 message_utils.py 的 content_to_text 提取文本内容
                "createdAt": _to_millis(msg.additional_kwargs.get("ts")),
            })
        elif msg.type == "ai" and msg.content:
            text = content_to_text(msg.content) #调用 message_utils.py 的 content_to_text 提取文本内容
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
    # enumerate 是 Python 内置函数，作用是遍历列表时同时拿到"下标"和"元素
    for i, m in enumerate(messages):
        # _msg_id() 是 message_utils.py 中的函数，作用是取 LangChain message 的物理 ID；读取时绝不临时生成 ID
        mid = _msg_id(m)
        # 对比当前消息的物理 ID 是否等于目标 ID
        # 如果相等，返回当前索引(下标)
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
    # Work 会话不支持编辑重发 / 重新生成：明确 409，避免误入 LangGraph hidden branch
    await _reject_work_thread_for_version_ops(thread_id)

    # 确保 graph 已初始化
    graph_instance = await _ensure_graph()

    # 1. 从当前 active leaf thread 读 messages
    # 调用 service.py 中的 _get_active_leaf_thread() 函数 读主会话当前活跃的 leaf thread_id。 没有记录或为 NULL 时，返回主 thread 自己
    active_leaf = await _get_active_leaf_thread(thread_id)
    # 调用 service.py 中的 _read_thread_messages() 函数 读取指定 thread 的原始 LangChain messages
    messages = await _read_thread_messages(active_leaf)
    if not messages:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )

    # 2. 用物理消息 ID 定位本次操作目标
    # 调用 message_utils.py 中的 _find_index_by_message_id() 函数 查找指定物理消息 ID 在 messages 中的索引
    anchor_index = _find_index_by_message_id(messages, target_message_id)
    # 如果未找到目标消息会返回 -1，抛出 APIException
    if anchor_index < 0:
        raise APIException(
            error_code=CustomExceptionCode.INVALID_ARGUMENT,
            http_status_code=400,
        )

    # 3. 解析 fork 点与 query
    if kind == "edit":
        # anchor 必须是 human；fork 到该 human 之前
        # 如果目标消息不是 human 类型，抛出 APIException
        if messages[anchor_index].type != "human":
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        human_index = anchor_index # 这是上面找到的下标索引
        # 如果新内容为空或仅包含空格，抛出 APIException
        if not new_content or not new_content.strip():
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        # 对新内容进行去空格处理
        query = new_content.strip()
    else:
        # regenerate: anchor 是 AI；fork 到它对应的 human 之前
        # 如果目标消息不是 ai 类型，抛出 APIException
        if messages[anchor_index].type != "ai":
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        # 如果未找到目标消息对应的 human 消息，抛出 APIException
        # 从 start（含）往前找最近一条 human 消息的索引，找不到返回 -1。
        human_index = _find_previous_human_index(messages, anchor_index)
        if human_index < 0:
            raise APIException(
                error_code=CustomExceptionCode.INVALID_ARGUMENT,
                http_status_code=400,
            )
        query = content_to_text(messages[human_index].content) #调用 message_utils.py 的 content_to_text 提取文本内容
    # 从 messages 中提取版本组 ID
    # 取跨 调用 _version_group_id() 函数 获取 anchor 稳定的版本组 ID，兼容尚无元数据的旧消息
    anchor_group_id = _version_group_id(messages[anchor_index]) # 锚点消息的组 ID
    human_group_id = _version_group_id(messages[human_index]) # human 消息的组
    if not anchor_group_id or not human_group_id:
        raise APIException(
            error_code=CustomExceptionCode.INVALID_ARGUMENT,
            http_status_code=400,
        )
    # 截断 messages 到 human_index 位置，包含 human_index 消息
    truncated = _truncate_before_index(messages, human_index)

    # 4. 每个消息位置都独立登记原版 0，再分配新版本号
    # 首次分叉某个消息位置时，登记它当前所在 leaf 为原版 0
    # 调用 service.py 中的 _ensure_base_version() 函数 允许sql语句插入数据
    await _ensure_base_version(thread_id, anchor_group_id, active_leaf)
    # 分配新版本号
    # 调用 service.py 中的 _next_branch_num() 函数 取该版本组已用过的最大 branch_num + 1
    branch_num = await _next_branch_num(thread_id, anchor_group_id)

    if kind == "edit":
        replay_human_group_id = anchor_group_id # edit 改的是 human，anchor 就是那条 human，所以沿用它的组名
        replay_human_version_num = branch_num # 这条 human 的新版本号 = 刚抢到的 branch_num
        replay_assistant_group_id = str(uuid4()) # AI 回答要重新生成，是全新的一组，生成新组名
        replay_assistant_version_num = 0 # 新组的第一个版本，从 0 开始
    else:
        replay_human_group_id = human_group_id
        replay_human_version_num = _version_num(messages[human_index])
        replay_assistant_group_id = anchor_group_id
        replay_assistant_version_num = branch_num

    def _make_hidden_tid(bn: int) -> str:
        # f-string（格式化字符串），用来拼出一个 hidden thread_id
        return f"{thread_id}_b{bn}_{uuid4().hex[:6]}"

    # 5. 先抢 branch_num（唯一约束保护并发安全）
    # 调用 service.py 中的 _allocate_branch_num_with_retry() 函数 用sql语句尝试插入umi_message_versions表，分配 branch_num
    # 在唯一约束保护下分配 branch_num。
    # 冲突时重新计算，最多重试 max_retries 次
    branch_num, hidden_thread_id = await _allocate_branch_num_with_retry(
        thread_id=thread_id,
        version_group_id=anchor_group_id,
        hidden_thread_id_factory=_make_hidden_tid,
        kind=kind,
    )

    # 6. 再创建 hidden thread 的 checkpoint
    # 创建新分支的 checkpoint，失败就回滚版本表记录——保证版本表和 checkpoint 两个存储不会不一致
    # 这一步为新建的分支创建checkpoint：把截断后的历史（fork点之前）写进新thread的状态。
    # 如果失败，就删掉上一步在版本表插的记录，避免留下"版本表说有、checkpoint 没有"的孤儿，
    # 然后重新抛异常。核心是跨两个存储的手动补偿——先做易回滚的版本表，后做难回滚的 checkpoint，失败就回滚前者。
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
    # 更新主会话的 active_leaf_thread_id
    await _set_active_leaf_thread(thread_id, hidden_thread_id)

    return {
        "thread_id": hidden_thread_id,  # 新分支的 thread_id
        "branch_num": branch_num,  # 新分支的版本号
        "query": query,  # 这轮发给模型的输入
        "version_group_id": anchor_group_id,  # 锚点版本组名
        "human_version_group_id": replay_human_group_id,  # human 侧版本组名
        "human_version_num": replay_human_version_num,  # human 侧版本号
        "assistant_version_group_id": replay_assistant_group_id,  # assistant 侧版本组名
        "assistant_version_num": replay_assistant_version_num,  # assistant 侧版本号
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
    # Work 会话不支持版本切换：明确 409
    await _reject_work_thread_for_version_ops(thread_id)

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
    # 找活跃叶子
    active_leaf = await _get_active_leaf_thread(thread_id)
    # 读指定 thread 的原始 LangChain messages
    raw_messages = await _read_thread_messages(active_leaf)
    if not raw_messages:
        return {
            "messages": [],
            "has_more": False,
            "next_cursor": None,
            "total": 0,
            "active_leaf_thread_id": active_leaf,
        }
    # 把 LangGraph 的原始消息数组扁平化成前端可用的消息列表。
    # 只保留 human 和「有 content 的 ai」两类，跳过纯工具调用消息
    all_messages = _flatten_messages(raw_messages)
    total = len(all_messages)
    # 首次请求，取最新一页消息
    if before is None:
        end = total
    else:
        #if before <= 0: end = 0 else: end = min(before, total)
        end = 0 if before <= 0 else min(before, total)

    start = max(0, end - limit)
    page = all_messages[start:end]
    has_more = start > 0
    # 下次前端就会把上次的 next_cursor 当作 before 传回来
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
# Work 会话门禁：归属校验 + 并发控制
# ─────────────────────────────────────────────────────────────


# 进程内 thread 级并发控制：同一 Work thread 同时只允许一个活跃 run。
# V0.5 先用进程内锁；Phase 1 引入 umi_work_runs 后再换成数据库部分唯一索引。
_active_work_threads: set[str] = set()
_work_threads_guard = asyncio.Lock()


async def _begin_work_run(thread_id: str) -> None:
    """占用该 thread 的 Work 运行位；已被占用则抛 409（不排队等待）。"""
    async with _work_threads_guard:
        if thread_id in _active_work_threads:
            raise APIException(
                error_code=CustomExceptionCode.WORK_THREAD_BUSY,
                http_status_code=409,
                description="该会话已有一个正在执行的任务，请先停止或等待其完成。",
            )
        _active_work_threads.add(thread_id)


async def _end_work_run(thread_id: str) -> None:
    """释放该 thread 的 Work 运行位。"""
    async with _work_threads_guard:
        _active_work_threads.discard(thread_id)


async def validate_work_request(thread_id: str, workspace_id: str) -> dict:
    """Work 请求门禁（只读校验，不写库）。

    与 Chat 分支的归属校验同语义，但 Work thread 是普通 thread id，
    不参与 `_bN_` hidden thread 解析。失败时抛出可直接映射为 HTTP 状态码的错误：

    - 工作区不存在            -> 404
    - 工作区不是 work 模式     -> 409
    - 工作区没有可用的本地目录  -> 400
    - thread 已属于别的工作区  -> 409
    - 该 thread 已有活跃 run   -> 409
    """
    workspace = await get_workspace(workspace_id)  # 不存在时抛 404

    if workspace.get("mode") != "work":
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=409,
            description="该工作区不是 Work 模式，无法作为 Work 会话运行。",
        )

    path = workspace.get("path")
    if not path or not os.path.isdir(path):
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=400,
            description="Work 工作区必须配置一个存在的本地目录。",
        )

    await _assert_thread_ownership(thread_id, workspace_id)

    if thread_id in _active_work_threads:
        raise APIException(
            error_code=CustomExceptionCode.WORK_THREAD_BUSY,
            http_status_code=409,
            description="该会话已有一个正在执行的任务，请先停止或等待其完成。",
        )

    return workspace


async def _assert_thread_ownership(thread_id: str, workspace_id: str) -> None:
    """thread 已存在时，必须属于请求里的同一个工作区，否则 409。"""
    async with db_connection.execute(
        "SELECT workspace_id FROM umi_threads WHERE thread_id = ?",
        (thread_id,),
    ) as cursor:
        existing = await cursor.fetchone()
    if existing and existing["workspace_id"] != workspace_id:
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=409,
            description="该会话不属于请求中的工作区。",
        )


async def register_work_thread(thread_id: str, workspace_id: str, user_query: str) -> None:
    """Work thread 登记：新 thread 写入 title，已存在则只刷新 updated_at。"""
    await db_connection.execute(
        """
        INSERT INTO umi_threads (thread_id, workspace_id, title, updated_at)
        VALUES (?, ?, ?, datetime('now'))
        ON CONFLICT (thread_id) DO UPDATE SET updated_at = datetime('now')
        """,
        (thread_id, workspace_id, (user_query or "")[:30]),
    )
    await db_connection.commit()


async def _reject_work_thread_for_version_ops(thread_id: str) -> None:
    """edit-resend / regenerate / version-switch 只支持 Chat 会话，Work 会话明确 409。"""
    async with db_connection.execute(
        """
        SELECT w.mode AS mode
        FROM umi_threads t
        JOIN umi_workspaces w ON w.workspace_id = t.workspace_id
        WHERE t.thread_id = ?
        """,
        (thread_id,),
    ) as cursor:
        row = await cursor.fetchone()
    if row and row["mode"] == "work":
        raise APIException(
            error_code=CustomExceptionCode.WORK_FEATURE_UNSUPPORTED,
            http_status_code=409,
            description="Work 会话暂不支持该操作。",
        )


# ─────────────────────────────────────────────────────────────
# 会话 CRUD
# ─────────────────────────────────────────────────────────────


async def work_stream(
    user_query: str,
    thread_id: str,
    workspace_id: str,
    human_version_group_id: str | None = None,
    human_version_num: int = 0,
    assistant_version_group_id: str | None = None,
    assistant_version_num: int = 0,
):
    """Work 模式的流式入口。V0 用 LocalDir + Runner 托管 session。"""
    from umi.work_agent import build_work_agent, build_work_run_config
    from agents import ItemHelpers

    workspace = await get_workspace(workspace_id)
    if not workspace.get("path"):
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=400,
            description="Work 工作区必须配置 path。",
        )

    agent = build_work_agent(workspace["path"])
    run_config = build_work_run_config()

    result = Runner.run_streamed(
        agent,
        user_query,
        run_config=run_config,
        max_turns=25,
    )

    async for event in result.stream_events():
        if event.type == "raw_response_event":
            # token 级流式文本
            if event.data.type == "response.output_text.delta":
                yield {"type": "text", "content": event.data.delta}
        elif event.type == "run_item_stream_event":
            if event.item.type == "tool_call_item":
                tool_name = getattr(event.item.raw_item, "name", "unknown")
                yield {"type": "tool_call", "name": tool_name, "status": "running"}
            elif event.item.type == "tool_call_output_item":
                yield {"type": "tool_result", "name": "tool", "status": "done"}
            elif event.item.type == "message_output_item":
                # message_output_item 是整段输出，raw delta 已经发过了，这里不再重复发全文
                pass




async def chat_stream(
        user_query: str,
        thread_id: str,
        workspace_id: str,
        human_version_group_id: str | None = None,
        human_version_num: int = 0,
        assistant_version_group_id: str | None = None,
        assistant_version_num: int = 0,
        mode: str = "chat",
):
    """
    流式对话。
    thread_id 现在是「当前 active leaf thread」，由 API 层决定。
    普通发送：active leaf = 主 thread 或某个 hidden thread。
    """

    # 先查 workspace，确认 mode
    workspace = await get_workspace(workspace_id)

    if workspace["mode"] == "work":
        # Work 分流：先完成归属校验与 umi_threads 登记，再进入 run。
        # Work thread 是普通 thread id，不参与 Chat 的 `_bN_` hidden thread 解析。
        await validate_work_request(thread_id, workspace_id)
        await register_work_thread(thread_id, workspace_id, user_query)
        await _begin_work_run(thread_id)
        try:
            async for event in work_stream(user_query, thread_id, workspace_id):
                yield event
        finally:
            await _end_work_run(thread_id)
        return

    from umi.compact_middleware import set_current_thread

    # 判断一个 thread_id 是不是 "hidden thread"，如果是，就剥掉 _b\d+_ 这段后缀，取出"主线程 ID"；否则原样返回

    # 解析主 thread：hidden thread 走 _b\d+_ 后缀
    # re.search	在字符串中任意位置搜索匹配，找到第一个就返回 Match 对象，否则返回 None
    # 整体模式 _b\d+_ 表示：下划线 → 字母 b → 至少一位数字 → 下划线
    is_hidden = "_b" in thread_id and re.search(r"_b\d+_", thread_id) is not None
    if is_hidden:
        # 示例:
        # thread_id	re.split 结果	[0] 得到
        # "main_b42_sub"	['main', 'sub']	"main"
        # "abc_b1_def_b2_ghi"	['abc', 'def', 'ghi']	"abc"
        # "job_b7_run"	['job', 'run']	"job"
        # "no_pattern_here"	['no_pattern_here']	"no_pattern_here"
        main_thread_id = re.split(r"_b\d+_", thread_id)[0]
    else:
        main_thread_id = thread_id
    # 调用 get_workspace 函数获取工作区信息 以 ID 作为条件，查该工作区的完整信息
    workspace = await get_workspace(workspace_id)

    async with db_connection.execute(
        "SELECT workspace_id FROM umi_threads WHERE thread_id = ?",
        (main_thread_id,),
    ) as cursor:
        existing_thread = await cursor.fetchone() # 异步数据库查询取一行
    if existing_thread and existing_thread["workspace_id"] != workspace_id:
        raise APIException(
            error_code=CustomExceptionCode.WORKSPACE_INVALID,
            http_status_code=409,
            description="该会话不属于请求中的工作区。",
        )
    if is_hidden and not existing_thread:
        raise APIException(
            error_code=CustomExceptionCode.THREAD_NOT_FOUND,
            http_status_code=404,
        )

    # 设置请求上下文，供归档和未来 Work 工具读取。
    set_current_thread(
        thread_id,
        main_thread_id,
        workspace_id,
        workspace["path"],
    )

    # 登记 umi_threads：主 thread 才写 title，hidden 只更新 updated_at
    if not is_hidden:
        await db_connection.execute(
            """
            INSERT INTO umi_threads
                (thread_id, workspace_id, title, updated_at)
            VALUES (?, ?, ?, datetime('now'))
            ON CONFLICT (thread_id) DO UPDATE SET updated_at = datetime('now')
            """,
            (thread_id, workspace_id, user_query[:30]),
        )
    else:
        await db_connection.execute(
            "UPDATE umi_threads SET updated_at = datetime('now') WHERE thread_id = ?",
            (main_thread_id,),
        )
    # 提交数据库事务
    await db_connection.commit()

    # 确保 graph 已初始化
    graph_instance = await _ensure_graph()
    config = {"configurable": {"thread_id": thread_id}}
    # 这行是给 human_group_id 赋值：优先用传入的 human_version_group_id，没有就新生成一个 UUID4 字符串
    human_group_id = human_version_group_id or str(uuid4())
    # 这行是给 assistant_group_id 赋值：优先用传入的 assistant_version_group_id，没有就新生成一个 UUID4 字符串
    assistant_group_id = assistant_version_group_id or str(uuid4())
    # 构建输入数据：包含用户查询、版本组 ID、版本号、时间戳等
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

    accumulated_text = "" # 累积已生成的文本
    current_task = asyncio.current_task() # 拿到当前 asyncio 任务
    if current_task:
        _active_tasks[thread_id] = current_task # 注册到全局表（用于外部取消） 代码在最上面

    try:
        async for event in graph_instance.astream_events(
                input_data, config=config, version="v2"
        ):
            #  event 是 astream_events 逐条吐出的事件字典
            kind = event["event"]
            if kind == "on_chat_model_stream":
                chunk = event["data"]["chunk"]
                if chunk.content: # chunk.content 是这片的文本。有内容才处理
                    accumulated_text += chunk.content # 累加，供中断时写回 checkpoint
                    yield {"type": "text", "content": chunk.content}
            elif kind == "on_tool_start":
                yield {"type": "tool_call", "name": event["name"], "status": "running"}
            elif kind == "on_tool_end":
                yield {"type": "tool_result", "name": event["name"], "status": "done"}
    except asyncio.CancelledError:
        if accumulated_text:
            try:
                # asyncio.shield，作用是"给一个 await 操作套一层保护罩"，让它在外层被取消时依然继续执行
                await asyncio.shield(
                    # 兜底里用它把中断前生成的部分文本写回 checkpoint，避免内容丢失
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
        # 没初始化就直接报错，避免后面 None.adelete_thread 崩
        if checkpointer is None:
            raise RuntimeError("Checkpointer 未初始化")

        # 收集所有相关 thread_id
        # 从版本表里查出这个主 thread 关联的所有 hidden 分支
        async with db_connection.execute(
            "SELECT hidden_thread_id FROM umi_message_versions WHERE thread_id = ?",
            (thread_id,),
        ) as cursor:
            hidden_rows = await cursor.fetchall() # 返回所有 hidden thread 的 ID.fetchall()返回所有剩余行

        for r in hidden_rows:
            # adelete_thread 是 LangGraph Checkpointer（检查点保存器）的一个内置异步方法
            # 根据传入的 thread_id，删除该会话在 Checkpointer 中存储的所有检查点和写入记录
            await checkpointer.adelete_thread(r["hidden_thread_id"])
        await checkpointer.adelete_thread(thread_id)

        await db_connection.execute(
            "DELETE FROM umi_message_versions WHERE thread_id = ?", (thread_id,)
        )
        await db_connection.execute(
            "DELETE FROM umi_threads WHERE thread_id = ?", (thread_id,)
        )
        # 提交事务，确保所有操作都生效
        await db_connection.commit()
    except Exception as e:
        if "not found" in str(e).lower():
            return
        raise APIException(
            error_code=CustomExceptionCode.THREAD_DELETE_FAILED,
            http_status_code=500,
        ) from e


async def list_conversations(workspace_id: str) -> list[dict]:
    """查询指定工作区的会话，按最近活跃排序。"""
    await get_workspace(workspace_id)
    async with db_connection.execute(
        """
        SELECT thread_id, workspace_id, title, created_at, updated_at,
               pinned, active_leaf_thread_id, worktree_path
        FROM umi_threads
        WHERE workspace_id = ?
        ORDER BY pinned DESC, updated_at DESC
        """,
        (workspace_id,),
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
    ) as cursor: # cursor ≠ 结果本身，它是"能拿到结果 + 能读元信息 + 能继续操作"的对象
        # rowcount 必须在 async with 块内部取，因为退出块后 cursor 可能已关闭，rowcount 就取不到了（取决于驱动）
        # rowcount = 被更新的行数
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
async def search_conversations(workspace_id: str, keyword: str) -> list[dict]:
    """
    按标题模糊搜索会话。
    keyword 为空时返回全部，方便前端统一调用。
    """
    await get_workspace(workspace_id)
    async with db_connection.execute(
        """
        SELECT thread_id, workspace_id, title, created_at, updated_at,
               pinned, active_leaf_thread_id, worktree_path
        FROM umi_threads
        WHERE workspace_id = ? AND title LIKE ?
        ORDER BY pinned DESC, updated_at DESC
        """,
        (workspace_id, f"%{keyword}%"),
    ) as cursor:
        rows = await cursor.fetchall()
    return [dict(r) for r in rows]
