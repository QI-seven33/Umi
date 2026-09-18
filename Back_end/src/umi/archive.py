# umi/archive.py
import json
import logging
from langchain_core.messages import BaseMessage
from umi.message_utils import content_to_text


# 用 __name__（即 umi.archive）命名 logger，是 Python 日志的标准做法，方便在日志配置里按模块粒度控制级别
logger = logging.getLogger(__name__)

async def archive_messages(
    db_connection,
    thread_id: str,
    leaf_thread_id: str,
    messages: list[BaseMessage],
) -> None:
    """
    把一批被压缩的消息逐条写入 umi_message_archive。
    尽力而为：失败只记日志，不抛异常，不阻断对话。
    """
    if not messages: # 空列表直接返回，避免后面无意义的 commit()。这是很常见的防御性早退。
        return
    try:
        for msg in messages:
            # getattr(object, name[, default])
            # object：要取属性的对象
            # name：要取的属性名
            # default：如果属性不存在，返回的默认值
            mid = getattr(msg, "id", None) # getattr(msg, "id", None)：安全取属性，取不到给 None
            # additional_kwargs 同理，且用 or {} 兜底，防止它是 None 导致后面 .get 报错
            kwargs = getattr(msg, "additional_kwargs", {}) or {}
            await db_connection.execute(
                """
                INSERT INTO umi_message_archive
                    (thread_id, leaf_thread_id, message_id,
                     version_group_id, version_num, role, content,
                     additional_kwargs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, # ? 是 参数化占位符（aiosqlite / sqlite3 风格），防止 SQL 注入，也比字符串拼接安全
                     # 8 个字段对应 8 个占位符，元组顺序必须严格一致


                (
                    thread_id,
                    leaf_thread_id,
                    str(mid) if mid else None,
                    kwargs.get("version_group_id"),
                    int(kwargs.get("version_num", 0) or 0),
                    getattr(msg, "type", "unknown"),
                    content_to_text(msg.content), #调用 message_utils.py 的 content_to_text 提取文本内容
                    json.dumps(kwargs, ensure_ascii=False),
                ),
            )
        await db_connection.commit() # await db_connection.commit()
    except Exception:
        await db_connection.rollback() #rollback() 回滚本次事务，再 logger.exception 记录完整堆栈。
        logger.exception(
            f"归档消息失败: thread_id={thread_id}, "
            f"leaf={leaf_thread_id}, count={len(messages)}"
        )
