from pydantic import BaseModel
from typing import Literal


class SearchSource(BaseModel):
    url: str
    title: str | None = None


class SearchArtifact(BaseModel):
    schema_version: Literal["1"] = "1"
    provider: str = "deepseek_server"
    query: str
    execution_status: Literal["succeeded", "failed"]
    evidence_status: Literal["found", "empty", "unknown"]
    sources: list[SearchSource] = []
    error_code: str | None = None
    latency_ms: int = 0