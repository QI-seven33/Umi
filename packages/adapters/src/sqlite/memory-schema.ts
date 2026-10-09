// 阶段 4 的实际结构；原消息、事件和工具执行不迁移或重写。
export const MEMORY_SCHEMA_SQL=`
CREATE TABLE memory_entries(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),
 execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id),kind TEXT NOT NULL CHECK(kind IN('note','requirement','reset')),
 artifact_ref TEXT NOT NULL REFERENCES artifacts(id));
CREATE TABLE context_maintenance(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),run_id TEXT NOT NULL REFERENCES runs(id),
 base_version INTEGER NOT NULL,source_fingerprint TEXT NOT NULL,mode TEXT NOT NULL CHECK(mode IN('compact','reset','budget-reset')),
 state TEXT NOT NULL CHECK(state IN('started','failed','completed')),plan_ref TEXT NOT NULL REFERENCES artifacts(id),
 summary_ref TEXT REFERENCES artifacts(id),manifest_ref TEXT REFERENCES artifacts(id),
 UNIQUE(conversation_id,base_version,source_fingerprint,mode));
CREATE TRIGGER immutable_memory_entry BEFORE UPDATE ON memory_entries BEGIN SELECT RAISE(ABORT,'记忆来源记录不可修改'); END;
CREATE TRIGGER immutable_maintenance_plan BEFORE UPDATE OF id,conversation_id,run_id,base_version,source_fingerprint,mode,plan_ref ON context_maintenance
 BEGIN SELECT RAISE(ABORT,'上下文维护计划不可修改'); END;
CREATE INDEX memory_entries_conversation ON memory_entries(conversation_id);
CREATE INDEX maintenance_run ON context_maintenance(run_id);
`;
