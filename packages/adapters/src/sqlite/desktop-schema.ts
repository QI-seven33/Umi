// 阶段 5 迁移指纹对实际 SQL 计算；已发布后不修改，后续变化另建迁移。
export const DESKTOP_SCHEMA_SQL=`
CREATE TABLE IF NOT EXISTS conversation_views(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),title TEXT,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)));
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),name TEXT NOT NULL,mime TEXT NOT NULL,byte_length INTEGER NOT NULL,artifact_ref TEXT NOT NULL REFERENCES artifacts(id));
CREATE TABLE IF NOT EXISTS message_attachments(message_id TEXT NOT NULL REFERENCES messages(id),attachment_id TEXT NOT NULL UNIQUE REFERENCES attachments(id),PRIMARY KEY(message_id,attachment_id));
CREATE TRIGGER IF NOT EXISTS immutable_attachment BEFORE UPDATE ON attachments BEGIN SELECT RAISE(ABORT,'附件不可改写');END;
`;
