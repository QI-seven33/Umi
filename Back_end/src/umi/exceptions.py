# exceptions.py
from api_exception import BaseExceptionCode


class CustomExceptionCode(BaseExceptionCode):
    # 基础服务错误
    INTERNAL_SERVER_ERROR = ("SRV-500", "服务内部错误", "服务暂时不可用，请稍后重试。")

    # 会话相关错误 (对接前端必备)
    THREAD_NOT_FOUND = ("THR-404", "会话不存在", "指定的 thread_id 找不到对应的对话记录。")
    THREAD_DELETE_FAILED = ("THR-500", "会话删除失败", "删除对话记录时发生错误。")
    THREAD_HISTORY_FAILED = ("THR-501", "会话历史查询失败", "查询对话记录时发生错误。")

    # LLM 及工具相关错误
    LLM_SERVICE_ERROR = ("LLM-503", "AI 服务不可用", "底层大模型服务暂时无法响应，请稍后再试。")
    TOOL_EXECUTION_FAILED = ("TOOL-500", "工具执行失败", "联网搜索等工具执行时发生错误。")

    # 你可以继续在这里添加更多业务错误
    # USER_NOT_FOUND = ("USR-404", "用户不存在", "该用户ID不存在。")
