// 阶段 3B 的事务迁移；程序定位、进程身份和输出均引用原工具执行。
export const PROCESS_SCHEMA_SQL=`
CREATE TABLE process_executions(execution_id TEXT PRIMARY KEY REFERENCES tool_executions(id),snapshot_ref TEXT NOT NULL REFERENCES artifacts(id),
  state TEXT NOT NULL CHECK(state IN('planned','ready','running','exited')),bridge_pid INTEGER,bridge_birth TEXT,child_pid INTEGER,child_birth TEXT,
  released INTEGER NOT NULL DEFAULT 0 CHECK(released IN(0,1)),receipt_ref TEXT REFERENCES artifacts(id));
CREATE TABLE process_outputs(execution_id TEXT NOT NULL REFERENCES process_executions(execution_id),output_index INTEGER NOT NULL CHECK(output_index>=0),
  channel TEXT NOT NULL CHECK(channel IN('stdout','stderr')),artifact_ref TEXT NOT NULL REFERENCES artifacts(id),byte_length INTEGER NOT NULL CHECK(byte_length>=0),
  PRIMARY KEY(execution_id,output_index));
CREATE TABLE process_fingerprints(environment_id TEXT NOT NULL REFERENCES environments(id),root TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(environment_id,root));
CREATE TRIGGER immutable_process_snapshot BEFORE UPDATE OF execution_id,snapshot_ref ON process_executions BEGIN SELECT RAISE(ABORT,'进程执行快照不可修改'); END;
CREATE TRIGGER immutable_process_identity BEFORE UPDATE OF bridge_pid,bridge_birth ON process_executions WHEN OLD.bridge_pid IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'进程身份不可替换'); END;
CREATE TRIGGER immutable_process_child BEFORE UPDATE OF child_pid,child_birth ON process_executions WHEN OLD.child_pid IS NOT NULL
  BEGIN SELECT RAISE(ABORT,'子进程身份不可替换'); END;
CREATE TRIGGER immutable_process_output BEFORE UPDATE ON process_outputs BEGIN SELECT RAISE(ABORT,'进程输出不可改写'); END;
`;
