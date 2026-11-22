// DB13：修订是追加事实，不修改原消息。旧程序会拒绝此格式，避免误用已退出视图的任务。
export const MESSAGE_REVISIONS_SCHEMA_SQL = `
CREATE TABLE message_revisions(
 id TEXT PRIMARY KEY REFERENCES events(event_id),
 conversation_id TEXT NOT NULL REFERENCES conversations(id),
 target_message_id TEXT NOT NULL REFERENCES messages(id),
 replacement_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
 user_cutoff INTEGER NOT NULL CHECK(user_cutoff>0),
 context_cutoff INTEGER NOT NULL CHECK(context_cutoff>0),
 end_sequence INTEGER NOT NULL CHECK(end_sequence>user_cutoff AND end_sequence>context_cutoff));
CREATE INDEX message_revisions_conversation ON message_revisions(conversation_id);
CREATE TRIGGER immutable_message_revision BEFORE UPDATE ON message_revisions
 BEGIN SELECT RAISE(ABORT,'消息修订不可改写'); END;
`;
