# umi/archive.py
import json
import logging
from langchain_core.messages import BaseMessage
from umi.message_utils import content_to_text
logger = logging.getLogger(__name__)


# def _content_to_text(content) -> str:
#     """把 LangChain message 的 content 归一化成纯字符串。"""
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
    if not messages:
        return
    try:
        for msg in messages:
            mid = getattr(msg, "id", None)
            kwargs = getattr(msg, "additional_kwargs", {}) or {}
            await db_connection.execute(
                """
                INSERT INTO umi_message_archive
                    (thread_id, leaf_thread_id, message_id,
                     version_group_id, version_num, role, content,
                     additional_kwargs)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    thread_id,
                    leaf_thread_id,
                    str(mid) if mid else None,
                    kwargs.get("version_group_id"),
                    int(kwargs.get("version_num", 0) or 0),
                    getattr(msg, "type", "unknown"),
                    content_to_text(msg.content),
                    json.dumps(kwargs, ensure_ascii=False),
                ),
            )
        await db_connection.commit()
    except Exception:
        await db_connection.rollback()
        logger.exception(
            f"归档消息失败: thread_id={thread_id}, "
            f"leaf={leaf_thread_id}, count={len(messages)}"
        )
