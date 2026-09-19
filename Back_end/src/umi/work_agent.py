from pathlib import Path
from agents import Runner, OpenAIResponsesModel, set_tracing_disabled
from agents.run import RunConfig
from agents.sandbox import Manifest, SandboxAgent, SandboxRunConfig
from agents.sandbox.capabilities import Shell, Filesystem
from agents.sandbox.entries import LocalDir
from agents.sandbox.sandboxes.docker import DockerSandboxClient, DockerSandboxClientOptions
from docker import from_env as docker_from_env
from openai import AsyncOpenAI
from api_exception import APIException
import os

from umi.exceptions import CustomExceptionCode

set_tracing_disabled(True)

def build_work_agent(workspace_path: str):
    """构建 Work 模式的 SandboxAgent。每次请求创建一个新实例。"""
    deepseek_client = AsyncOpenAI(
        api_key=os.getenv("DEEPSEEK_API_KEY"),
        base_url="https://api.deepseek.com",
    )
    model = OpenAIResponsesModel(model="deepseek-flash", openai_client=deepseek_client)

    return SandboxAgent(
        name="Umi Work",
        model=model,
        instructions=(
            "你的工作区挂载在 `repo/` 目录下。"
            "你可以读取 `repo/` 下的任何文件。"
            "当需要修改或创建文件时，使用 `apply_patch` 工具，路径相对于工作区根目录。"
        ),
        default_manifest=Manifest(
            entries={"repo": LocalDir(src=Path(workspace_path))},
        ),
        capabilities=[Shell(), Filesystem()],
    )

def build_work_run_config():
    """构建 Work 模式的 RunConfig，让 Runner 完整管理 session 生命周期。

    Docker 不可用（未安装 / Docker Desktop 未启动 / 管道不可达）时这里直接抛出
    可读的配置错误：否则底层连接异常会在流中途冒出来，被 api.py 的统一兜底
    变成「服务暂时不可用，请稍后重试」，用户无从判断是环境问题还是模型问题。
    """
    try:
        docker_client = docker_from_env()
        docker_client.ping()
    except APIException:
        raise
    except Exception as exc:
        raise APIException(
            error_code=CustomExceptionCode.SANDBOX_UNAVAILABLE,
            http_status_code=503,
            description=(
                "未检测到可用的 Docker 环境，Work 模式需要 Docker 正在运行："
                "请确认已安装 Docker Desktop 并处于启动状态后重试。"
            ),
        ) from exc

    return RunConfig(
        sandbox=SandboxRunConfig(
            client=DockerSandboxClient(docker_client),
            options=DockerSandboxClientOptions(image="python:3.14-slim"),
            cwd="repo",
        ),
    )
