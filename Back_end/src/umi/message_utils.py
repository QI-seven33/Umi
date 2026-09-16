# umi/message_utils.py
"""LangChain message 的通用处理工具。"""


def content_to_text(content) -> str:
    """把 LangChain 1.x 的 content 归一化成纯字符串。

    content 可能是：
      - str：旧格式，直接用
      - list[dict]：新格式，如 [{"type": "text", "text": "...", "index": 0}]
    """
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                if block.get("type") == "text" and "text" in block:
                    parts.append(block["text"])
        return "".join(parts)
    return str(content) if content else ""