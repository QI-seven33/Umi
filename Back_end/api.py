# api.py
import json
import asyncio
import logging
from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from api_exception import register_exception_handlers, ResponseModel, APIException
from umi.service import (
    init_agent_service,
    shutdown_agent_service,
    chat_invoke,
    chat_stream,
    delete_conversation_thread,
    get_conversation_messages_paginated,
    rename_conversation,
    set_conversation_pinned,
    list_conversations,
    create_version_branch,
    get_message_versions,
    switch_active_version,
    get_messages_from_thread,
    _get_active_leaf_thread,
    search_conversations,
    create_workspace,
    delete_workspace,
    get_workspace,
    list_workspaces,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    force=True,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# 请求模型
# ─────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    workspace_id: str = Field(..., min_length=1)
    query: str = Field(..., min_length=1, max_length=5000)
    mode: Literal["chat", "work"] = Field("chat")
    human_version_group_id: str | None = None
    human_version_num: int = Field(0, ge=0)
    assistant_version_group_id: str | None = None
    assistant_version_num: int = Field(0, ge=0)


class ChatHistoryRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    limit: int = Field(20, ge=1, le=100)
    before: int | None = Field(None, ge=0)


class ThreadIdRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)


class RenameThreadRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    title: str = Field(..., min_length=1, max_length=100)


class PinThreadRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    pinned: bool


class EditResendRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    message_id: str = Field(..., min_length=1, description="active leaf 中被编辑 human 的物理 ID")
    new_content: str = Field(..., min_length=1, max_length=5000)


class RegenerateRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    message_id: str = Field(..., min_length=1, description="active leaf 中被重新生成 AI 的物理 ID")


class SwitchVersionRequest(BaseModel):
    thread_id: str = Field(..., min_length=1)
    version_group_id: str = Field(..., min_length=1)
    branch_num: int = Field(..., ge=0)


class CreateWorkspaceRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    path: str | None = Field(None, max_length=2000)
    mode: Literal["chat", "work"]




# 装饰器，把异步生成器函数变成异步上下文管理器
@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_agent_service()
    yield
    await shutdown_agent_service() # 关闭数据库连接


app = FastAPI(title="Umi AI Agent API", lifespan=lifespan)
register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─────────────────────────────────────────────────────────────
# 对话
# ─────────────────────────────────────────────────────────────

# @app.post("/api/chat")
# async def chat(req: ChatRequest):
#     res = await chat_invoke(req.query, req.thread_id)
#     return ResponseModel(
#         data={"thread_id": req.thread_id, "reply": res["messages"][-1].content},
#         message="对话成功",
#     )


@app.post("/api/chat/stream")
async def chat_sse(req: ChatRequest, request: Request):
    """
    流式对话。
    前端传的 thread_id 是「当前 active leaf thread」。
    如果前端不知道 active leaf，可以传主 thread id，
    这里会通过 _get_active_leaf_thread 解析。
    """
    # 解析真正的执行 thread：如果传的是主 thread，用 active leaf 覆盖
    # 寻找活跃会话
    async def resolve_leaf():
        return await _get_active_leaf_thread(req.thread_id)

    async def sse_generator():
        try:
            leaf = await resolve_leaf()
            # 调用 chat_stream 函数，生成流式事件
            async for evt in chat_stream(
                req.query,
                leaf,
                workspace_id=req.workspace_id,
                human_version_group_id=req.human_version_group_id,
                human_version_num=req.human_version_num,
                assistant_version_group_id=req.assistant_version_group_id,
                assistant_version_num=req.assistant_version_num,
            ):
                if await request.is_disconnected():
                    logger.info(f"客户端断开，停止生成: thread_id={leaf}")
                    break
                # 把前面拿到的事件字典序列化成 JSON 字符串，准备发给客户端（通常是 SSE 帧）
                payload = json.dumps(evt, ensure_ascii=False)
                event_name = {
                    "text": "message",
                    "tool_call": "tool_call",
                    "tool_result": "tool_result",
                }[evt["type"]]
                yield f"event: {event_name}\ndata: {payload}\n\n"
            yield "event: done\ndata: [DONE]\n\n"
        except asyncio.CancelledError:
            yield "event: close\ndata: 连接已关闭\n\n"
            raise
        except APIException as e:
            logger.warning(f"SSE 业务异常: {e.message}")
            yield f"event: error\ndata: {e.message}\n\n"
            yield "event: done\ndata: [DONE]\n\n"
        except Exception:
            logger.exception("SSE 流式对话发生未知异常")
            yield "event: error\ndata: 服务暂时不可用，请稍后重试\n\n"
            yield "event: done\ndata: [DONE]\n\n"
    # 这是 FastAPI 返回一个 SSE（Server-Sent Events）流式响应的标准写法。
    # 作用是把 sse_generator() 产出的数据边生成边推给客户端，而不是等全部生成完再一次性返回
    return StreamingResponse(
        sse_generator(), # 调用 sse_generator() 异步生成器，逐条 yield 数据
        media_type="text/event-stream",  #  SSE 的 MIME 类型
        headers={
            "Cache-Control": "no-cache", # 禁止缓存
            "X-Accel-Buffering": "no", # 禁用 Nginx 缓冲
        },
    )


# ─────────────────────────────────────────────────────────────
# 历史
# ─────────────────────────────────────────────────────────────

@app.post("/api/chat/history")
async def get_history(req: ChatHistoryRequest):
    # 调用 get_conversation_messages_paginated 获取指定会话当前 active leaf 的分页消息列表 并计算返回消息的条数
    result = await get_conversation_messages_paginated(
        req.thread_id, req.limit, req.before
    )
    return ResponseModel(
        data={
            "thread_id": req.thread_id,
            "messages": result["messages"],
            "has_more": result["has_more"],
            "next_cursor": result["next_cursor"],
            "total": result["total"],
            "active_leaf_thread_id": result["active_leaf_thread_id"],
        },
        message="获取历史成功",
    )


# ─────────────────────────────────────────────────────────────
# 会话 CRUD
# ─────────────────────────────────────────────────────────────

@app.delete("/api/chat/thread")
async def delete_thread(req: ThreadIdRequest):
    # 删除主会话：删主 thread、所有 hidden thread 的检查点、版本表记录、主会话元数据
    await delete_conversation_thread(req.thread_id)
    return ResponseModel(data={"thread_id": req.thread_id}, message="会话删除成功")


@app.get("/api/chat/threads")
async def list_threads(workspace_id: str):
    # 查询指定工作区的会话，按最近活跃排序。
    threads = await list_conversations(workspace_id)
    return ResponseModel(data={"threads": threads}, message="获取会话列表成功")


@app.patch("/api/chat/thread/title")
async def rename_thread(req: RenameThreadRequest):
    # 重命名会话标题
    await rename_conversation(req.thread_id, req.title)
    return ResponseModel(
        data={"thread_id": req.thread_id, "title": req.title}, message="重命名成功"
    )


@app.patch("/api/chat/thread/pin")
async def pin_thread(req: PinThreadRequest):
    # 置顶会话
    await set_conversation_pinned(req.thread_id, req.pinned)
    return ResponseModel(
        data={"thread_id": req.thread_id, "pinned": req.pinned},
        message="置顶状态已更新",
    )


@app.post("/api/chat/stop")
async def stop_chat(req: ThreadIdRequest):
    from umi.service import _active_tasks
    # 读主会话当前活跃的 leaf thread_id。没有记录或为 NULL 时，返回主 thread 自己
    leaf = await _get_active_leaf_thread(req.thread_id)
    task = _active_tasks.get(leaf) # 用 leaf 当键去字典里查 查到的 asyncio.Task；查不到返回 None
    # 确认任务存在且还在运行中，才取消
    if task and not task.done():
        # task.cancel() 发取消信号，不是立刻杀死
        task.cancel()
        # 返回 stopped: True，前端据此把"生成中"UI 切回"已停止"
        return ResponseModel(data={"stopped": True}, message="已停止")
    return ResponseModel(data={"stopped": False}, message="无活跃任务")


# ─────────────────────────────────────────────────────────────
# 版本分支
# ─────────────────────────────────────────────────────────────

@app.post("/api/chat/edit-resend")
async def edit_resend(req: EditResendRequest):
    # 调用 从当前 active leaf thread 分叉一个新分支
    result = await create_version_branch(
        thread_id=req.thread_id,
        target_message_id=req.message_id, # # 用户点的那条消息的物理 ID
        new_content=req.new_content, # # 用户改后的新内容
        kind="edit",
    )
    return ResponseModel(
        data={
            "query": result["query"],
            "exec_thread_id": result["thread_id"],
            "branch_num": result["branch_num"],
            "version_group_id": result["version_group_id"],
            "human_version_group_id": result["human_version_group_id"],
            "human_version_num": result["human_version_num"],
            "assistant_version_group_id": result["assistant_version_group_id"],
            "assistant_version_num": result["assistant_version_num"],
        },
        message="已创建新版本",
    )


@app.post("/api/chat/regenerate")
async def regenerate(req: RegenerateRequest):
    # 重新生成
    result = await create_version_branch(
        thread_id=req.thread_id,
        target_message_id=req.message_id,
        new_content=None,
        kind="regenerate",
    )
    return ResponseModel(
        data={
            "query": result["query"],
            "exec_thread_id": result["thread_id"],
            "branch_num": result["branch_num"],
            "version_group_id": result["version_group_id"],
            "human_version_group_id": result["human_version_group_id"],
            "human_version_num": result["human_version_num"],
            "assistant_version_group_id": result["assistant_version_group_id"],
            "assistant_version_num": result["assistant_version_num"],
        },
        message="已创建新版本",
    )


@app.get("/api/chat/thread/{thread_id}/versions")
async def get_versions(thread_id: str):
    """
    返回该会话所有版本的映射：
    { version_group_id: [ {branch_num, hidden_thread_id, kind}, ... ] }
    """
    versions = await get_message_versions(thread_id)
    return ResponseModel(
        data={"thread_id": thread_id, "versions": versions},
        message="获取版本信息成功",
    )


@app.post("/api/chat/version/switch")
async def switch_version(req: SwitchVersionRequest):
    hidden = await switch_active_version(
        req.thread_id, req.version_group_id, req.branch_num
    )
    messages = await get_messages_from_thread(hidden)
    return ResponseModel(
        data={
            "thread_id": req.thread_id,
            "version_group_id": req.version_group_id,
            "branch_num": req.branch_num,
            "hidden_thread_id": hidden,
            "messages": messages,
        },
        message="版本切换成功",
    )

@app.get("/api/chat/threads/search")
async def search_threads(workspace_id: str, q: str = ""):
    # 按标题模糊搜索会话。q 为空时返回全部，方便前端统一调用
    threads = await search_conversations(workspace_id, q)
    return ResponseModel(data={"threads": threads}, message="搜索成功")


# ─────────────────────────────────────────────────────────────
# 工作区
# ─────────────────────────────────────────────────────────────

@app.post("/api/workspaces")
async def create_workspace_route(req: CreateWorkspaceRequest):
    # 调用 create_workspace 创建工作区。Chat 的默认工作区只允许由数据库初始化
    workspace_id = await create_workspace(req.name, req.path, req.mode)
    workspace = await get_workspace(workspace_id)
    return ResponseModel(data={"workspace": workspace}, message="工作区创建成功")


@app.get("/api/workspaces")
async def list_workspaces_route(mode: Literal["chat", "work"] | None = None):
    # 调用 list_workspaces 获取所有工作区。mode 为空时返回所有工作区，mode 为 chat 时返回 Chat 工作区，mode 为 work 时返回 Work 工作区
    workspaces = await list_workspaces(mode)
    return ResponseModel(data={"workspaces": workspaces}, message="获取工作区成功")


@app.delete("/api/workspaces/{workspace_id}")
async def delete_workspace_route(workspace_id: str):
    # 调用 delete_workspace 删除工作区数据库记录与 checkpoints，不接触其物理目录
    await delete_workspace(workspace_id)
    return ResponseModel(
        data={"workspace_id": workspace_id},
        message="工作区删除成功",
    )
