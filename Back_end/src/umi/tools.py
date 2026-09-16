from umi.config import tavily_api_key
from langchain_tavily import TavilySearch
from langchain_core.tools import tool
from openai.types.responses import WebSearchToolParam
from openai import AsyncOpenAI
from umi.config import llm_api_key, llm_base_url
import asyncio
import json
import time
from umi.tool_results import SearchArtifact, SearchSource

tavily_search_tool = TavilySearch(
    max_results=1,
    topic="general",
    api_key=tavily_api_key,

)

ds_client = AsyncOpenAI(api_key=llm_api_key, base_url=llm_base_url)




@tool(response_format="content_and_artifact")
async def deepseek_server_web_search(query: str) -> tuple[str, SearchArtifact]:
    """联网搜索，获取实时新闻、最新公开信息。"""
    start = time.monotonic()
    try:
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
            if item.type == "web_search_call" and item.status == "completed":
                for src in item.action.sources:
                    sources.append(SearchSource(url=src.url))

        content = resp.output_text
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
            error_code=type(e).__name__,
            latency_ms=int((time.monotonic() - start) * 1000),
        )
        return "", artifact


# case1：总是抛出异常，用来测试重试耗尽进入error_handler
@tool
async def mock_bad_tool() -> str:
    """模拟一个总是报错的工具"""
    i = 0
    print(f"一次重试{i + 1}")
    raise RuntimeError("模拟工具执行失败！")


# case2：模拟长时间sleep，触发节点TimeoutPolicy超时
@tool
async def mock_slow_tool() -> str:
    """模拟慢工具，sleep 70秒，超过节点run_timeout=60"""
    await asyncio.sleep(70)
    return "slow tool done"
