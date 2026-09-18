# umi/message_utils.py
"""LangChain message 的通用处理工具。"""


def content_to_text(content) -> str:
    """把 LangChain 1.x 的 content 归一化成纯字符串。

    content 可能是：
      - str：旧格式，直接用
      - list[dict]：新格式，如 [{"type": "text", "text": "...", "index": 0}]
    """
    # ：本来就是字符串 → 直接用 "你好"
    # isinstance(对象, 类型) ：判断对象是否是指定类型的实例 返回 True 或 False
    if isinstance(content, str):
        return content
    # 是列表（新版多模态格式）→ 逐个块提取文本 [{"type":"text","text":"你好"}]
    if isinstance(content, list):
        parts = []
        for block in content:
            #  块本身是字符串 → 直接加 ["你好", "世界"]
            if isinstance(block, str):
                parts.append(block)
            #  块是 dict → 只取 type=="text" 的 text 字段 [{"type":"image",...}]
            elif isinstance(block, dict):
                if block.get("type") == "text" and "text" in block:
                    parts.append(block["text"])
        # "".join(parts)：用空字符串拼接所有文本块，不留分隔符。所以 ["你好", "世界"] → "你好世界"
        return "".join(parts) #
    # 其他类型（None、数字等）→ 兜底转字符串 None 123
    # str(对象) ：把对象转换为字符串
    return str(content) if content else ""