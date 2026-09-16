from uuid import uuid4
import pytest
import asyncio
from langchain_core.messages import HumanMessage, AIMessage, ToolMessage
from umi.graph import evaluate_node
from umi.service import create_version_branch, chat_invoke
from umi.tool_results import SearchArtifact, SearchSource


# ---------- evaluate_node 单元测试 ----------

def test_evaluate_node_found():
    artifact = SearchArtifact(
        query="test",
        execution_status="succeeded",
        evidence_status="found",
        sources=[SearchSource(url="https://example.com")],
    )
    state = {
        "messages": [
            HumanMessage(content="测试"),
            ToolMessage(content="搜索结果", tool_call_id="call_1", artifact=artifact),
            AIMessage(content="回答"),
        ],
        "retry_count": 0,
    }
    assert evaluate_node(state)["status"] == "sufficient"


def test_evaluate_node_empty_evidence():
    artifact = SearchArtifact(
        query="test",
        execution_status="succeeded",
        evidence_status="empty",
    )
    state = {
        "messages": [
            HumanMessage(content="测试"),
            ToolMessage(content="", tool_call_id="call_1", artifact=artifact),
            AIMessage(content="回答"),
        ],
        "retry_count": 0,
    }
    assert evaluate_node(state)["status"] == "insufficient"


def test_evaluate_node_tool_failed():
    artifact = SearchArtifact(
        query="test",
        execution_status="failed",
        evidence_status="unknown",
        error_code="TimeoutError",
    )
    state = {
        "messages": [
            HumanMessage(content="测试"),
            ToolMessage(content="", tool_call_id="call_1", artifact=artifact),
            AIMessage(content="回答"),
        ],
        "retry_count": 0,
    }
    assert evaluate_node(state)["status"] == "insufficient"


def test_evaluate_node_ignores_old_artifact():
    old_artifact = SearchArtifact(
        query="old",
        execution_status="succeeded",
        evidence_status="found",
        sources=[SearchSource(url="https://old.com")],
    )
    state = {
        "messages": [
            HumanMessage(content="第一轮"),
            ToolMessage(content="旧结果", tool_call_id="call_old", artifact=old_artifact),
            AIMessage(content="旧回答"),
            HumanMessage(content="第二轮纯聊天"),
            AIMessage(content="新回答"),
        ],
        "retry_count": 0,
    }
    assert evaluate_node(state)["status"] == "sufficient"


def test_evaluate_node_missing_artifact():
    state = {
        "messages": [
            HumanMessage(content="测试"),
            ToolMessage(content="旧格式结果", tool_call_id="call_1"),
            AIMessage(content="回答"),
        ],
        "retry_count": 0,
    }
    assert evaluate_node(state)["status"] == "sufficient"


def test_evaluate_node_retry_exhausted():
    artifact = SearchArtifact(
        query="test",
        execution_status="succeeded",
        evidence_status="empty",
    )
    state = {
        "messages": [
            HumanMessage(content="测试"),
            ToolMessage(content="", tool_call_id="call_1", artifact=artifact),
            AIMessage(content="回答"),
        ],
        "retry_count": 2,
    }
    assert evaluate_node(state)["status"] == "insufficient"


