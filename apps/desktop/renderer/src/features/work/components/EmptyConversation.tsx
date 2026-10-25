import { t as uiText } from '../../../ui-language.js';
export function EmptyConversation() {
  return <section className="empty-conversation" aria-label={uiText("开始对话")}>
    <h1 className="welcome-title">Thus begins the story.</h1>
  </section>;
}
