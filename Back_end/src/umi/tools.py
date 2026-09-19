from langchain_core.tools import tool
from openai.types.responses import WebSearchToolParam
from openai import AsyncOpenAI
from umi.config import llm_api_key, llm_base_url
import asyncio
import json
import time
from umi.tool_results import SearchArtifact, SearchSource

# AsyncOpenAI 是 OpenAI 官方 SDK 的异步客户端类
ds_client = AsyncOpenAI(api_key=llm_api_key, base_url=llm_base_url)

# "content_and_artifact"（返回 内容 + 附加数据）
# SearchArtifact是tool_results.py模块的类型，用于存储搜索结果的元数据
@tool(response_format="content_and_artifact")
async def deepseek_server_web_search(query: str) -> tuple[str, SearchArtifact]:
    """联网搜索，获取实时新闻、最新公开信息。"""

    # time.monotonic() 返回一个单调递增的时钟值（不受系统时间调整影响）
    # 记下开始时间，后面算 latency_ms
    start = time.monotonic()
    try:
        # DeepSeek responses API 的创建接口
        resp = await ds_client.responses.create(
            model="deepseek-v4-flash",
            input=[{
                "role": "user",
                "content": (
                    "请只做信息检索。不要写回答，不要总结，不要分点，不要列表，不要小标题。"
                    "只把搜到的关键事实按句子顺序吐出来，一句接一句，事实之间用句号分隔。"
                    "不要润色，不要组织逻辑，不要加粗、不要标题。"
                    "如果搜索结果里有代码、命令行或 URL，原样保留，不要改写。"
                    f"问题：{query}"
                ),
            }],
            tools=[WebSearchToolParam(type="web_search")],
        )

        # 从 web_search_call items 中提取 sources
        sources: list[SearchSource] = []
        for item in resp.output:
            # item.type == "web_search_call" 筛选出"网页搜索调用"项
            if item.type == "web_search_call" and item.status == "completed":
                for src in item.action.sources:
                    # src.url —— 取每个源的 url 字段
                    # SearchSource(url=...) —— 构造一个新的 SearchSource 对象 并追加到 sources 列表中
                    sources.append(SearchSource(url=src.url))

        # resp.output_text 是 API 返回的纯文本输出
        content = resp.output_text
        # 用 SearchArtifact 这个 Pydantic 类作为"模板/契约"，把实际值填进去，构造出一个符合类型定义的对象
        artifact = SearchArtifact(
            provider="deepseek_server",
            query=query,
            execution_status="succeeded",
            evidence_status="found" if sources else "empty",
            sources=sources,
            latency_ms=int((time.monotonic() - start) * 1000),
        )
        return content, artifact

    except Exception as e:
        artifact = SearchArtifact(
            provider="deepseek_server",
            query=query,
            execution_status="failed",
            evidence_status="unknown",
            error_code=type(e).__name__, # __name__ 类对象的特殊属性，返回类名字符串
            latency_ms=int((time.monotonic() - start) * 1000), # 调用 time 模块的 monotonic 函数，返回当前单调时钟值（float） 并转成毫秒
        )
        # return 后跟多个值，用逗号分隔 → 自动打包成元组
        return "", artifact


