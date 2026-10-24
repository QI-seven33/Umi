import {UmiApplication} from '../apps/headless/src/application.js';
import type {Settings} from '../packages/protocol/src/model.js';
// 显式构造升级前会话；历史副本/冻结交付测试继续验证原协议，新默认直改在direct-files.test中验收。
export class LegacyFileApplication extends UmiApplication {
  override createConversation(workspace:string,settings:Partial<Settings>={}) {
    const c=this.store.createConversation(workspace,settings);this.files.initialize(c.environmentId);return c;
  }
}
