// 阶段 3A 事务迁移；指纹对 SQL 原文计算，版本发布后不改写。
export const RESOURCE_SCHEMA_SQL = `
        CREATE TABLE IF NOT EXISTS resource_candidates(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES environments(id),path TEXT NOT NULL,
          identity TEXT NOT NULL,initial INTEGER NOT NULL CHECK(initial IN(0,1)),created_at TEXT NOT NULL,UNIQUE(environment_id,path,identity));
        CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY REFERENCES resource_candidates(id),environment_id TEXT NOT NULL REFERENCES environments(id));
        CREATE TABLE IF NOT EXISTS capabilities(id TEXT PRIMARY KEY,resource_id TEXT NOT NULL REFERENCES resources(id),environment_id TEXT NOT NULL REFERENCES environments(id),
          run_id TEXT REFERENCES runs(id),access TEXT NOT NULL CHECK(access IN('read','edit')),approval_id TEXT REFERENCES approval_requests(id));
        CREATE TABLE IF NOT EXISTS resource_denials(environment_id TEXT NOT NULL REFERENCES environments(id),path TEXT NOT NULL,identity TEXT NOT NULL,access TEXT NOT NULL,
          PRIMARY KEY(environment_id,path,identity,access));
        CREATE TABLE IF NOT EXISTS mounts(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES environments(id),resource_id TEXT NOT NULL REFERENCES resources(id),
          root TEXT NOT NULL UNIQUE,root_identity TEXT NOT NULL,binding_version INTEGER NOT NULL DEFAULT 1,baseline_ref TEXT NOT NULL REFERENCES artifacts(id),
          source_root TEXT NOT NULL,source_identity TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS materializations(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES environments(id),resource_id TEXT NOT NULL REFERENCES resources(id),
          plan_ref TEXT NOT NULL REFERENCES artifacts(id),root_identity TEXT);
        CREATE TABLE IF NOT EXISTS changesets(id TEXT PRIMARY KEY,environment_id TEXT NOT NULL REFERENCES environments(id),mount_id TEXT NOT NULL REFERENCES mounts(id),
          artifact_ref TEXT NOT NULL REFERENCES artifacts(id),execution_id TEXT NOT NULL UNIQUE REFERENCES tool_executions(id));
        CREATE TABLE IF NOT EXISTS delivery_items(changeset_id TEXT NOT NULL REFERENCES changesets(id),path TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES tool_executions(id),
          state TEXT NOT NULL CHECK(state IN('intent','settled')),receipt_ref TEXT REFERENCES artifacts(id),temporary_path TEXT,PRIMARY KEY(changeset_id,path));
        CREATE TRIGGER IF NOT EXISTS immutable_mount BEFORE UPDATE OF root,root_identity,environment_id,resource_id,binding_version,source_root,source_identity ON mounts
          BEGIN SELECT RAISE(ABORT,'挂载绑定不可修改'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_changeset BEFORE UPDATE ON changesets BEGIN SELECT RAISE(ABORT,'变更集不可修改'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_candidate BEFORE UPDATE ON resource_candidates BEGIN SELECT RAISE(ABORT,'候选来源身份不可修改'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_capability BEFORE UPDATE ON capabilities BEGIN SELECT RAISE(ABORT,'能力范围不可改写'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_materialization BEFORE UPDATE OF id,environment_id,resource_id,plan_ref ON materializations BEGIN SELECT RAISE(ABORT,'物化定位不可改写'); END;
        CREATE TRIGGER IF NOT EXISTS immutable_materialization_root BEFORE UPDATE OF root_identity ON materializations WHEN OLD.root_identity IS NOT NULL AND NEW.root_identity IS NOT OLD.root_identity
          BEGIN SELECT RAISE(ABORT,'物化根身份不可替换'); END;
        CREATE INDEX IF NOT EXISTS capabilities_scope ON capabilities(environment_id,resource_id,run_id);
      `;
