import { filePreviewFixtures } from './verification-preview-fixtures.js';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { nativeImage, type BrowserWindow } from 'electron';
import type { AgentBroker } from './broker.js';
import { initialState, reduceConversation } from '../../packages/protocol/src/reducer.js';
import type { Snapshot } from './renderer/src/transport.js';
async function until<T>(read: () => Promise<T>, test: (x: T) => boolean) {
  // 在等待开始处保留调用栈，失败报告可定位具体检查，避免所有等待只报同一句话。
  const failure = Error('桌面验收条件未满足');
  for (let i = 0; i < 160; i++) {
    const r = await read();
    if (test(r)) return r;
    await delay(100);
  }
  throw failure;
}
export async function verifyDesktop(
  broker: AgentBroker,
  win: BrowserWindow,
  dataRoot: string,
) {
  if (process.argv.includes('--preview-only')) {
    const { verifyFilePreview } = await import('./verification-file-preview.js');
    return verifyFilePreview(broker, win, dataRoot);
  }
  // Windows 隐藏窗口可能保留旧合成帧；截图需要实际可见的合成表面。
  // 真实可见但不抢焦点的独立验收窗口，确保 Windows 合成器绘制跨进程 HTML。
  win.setOpacity(1);
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
  const evidence: { name: string; passed: boolean; details?: unknown }[] = [],
    pass = (name: string, details?: unknown) =>
      { evidence.push({ name, passed: true, ...(details ? { details } : {}) }); writeFileSync(join(dataRoot,'desktop-progress.json'),JSON.stringify({checks:evidence.length,last:name})); };
  const report = join(dataRoot, 'desktop-verification.json');
  const captureFrame = async (stayAwake = false) => {
    let last: unknown;
    for(let attempt=0;attempt<4;attempt++) {
      try { return await win.webContents.capturePage(undefined,{stayAwake:stayAwake||attempt>0}); }
      catch(error) { if(!String(error).includes('UnknownVizError'))throw error;last=error;await delay(120); }
    }
    throw last;
  };
  // 与同一容器中的普通输入框实测对比，覆盖宽聊天区和侧栏挤压后的窄布局。
  const composerSize = async (selector: string) => {
    const bounds = win.getBounds();
    const panelWasOpen = await win.webContents.executeJavaScript(`document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true'`);
    const restorePanel = () => win.webContents.executeJavaScript(`if((document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true')!==${panelWasOpen})document.querySelector('.right-rail-toggle').click();`);
    const measure = () => win.webContents.executeJavaScript(`(() => {
      const card=document.querySelector(${JSON.stringify(selector)}), reference=document.createElement('div');
      reference.className='composer'; reference.style.cssText='visibility:hidden;height:0;min-height:0;padding:0;margin-block:0';
      card.parentElement.append(reference);
      const actual=card.getBoundingClientRect(), expected=reference.getBoundingClientRect(), style=getComputedStyle(card);
      const result={width:actual.width,left:actual.left,expectedWidth:expected.width,expectedLeft:expected.left,height:actual.height,radius:style.borderRadius,font:style.fontSize,fontFamily:style.fontFamily,shadow:style.boxShadow,breathing:!!card.querySelector('.composer-breathing')};
      reference.remove(); return result;
    })()`);
    try {
      win.setSize(1440,bounds.height); await delay(180); const wide=await measure();
      win.setSize(1120,bounds.height);
      await win.webContents.executeJavaScript(`if(document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('.right-rail-toggle').click();`);
      await delay(260); const narrow=await measure();
      assert(narrow.width<=528, '窄布局应覆盖聊天区560px以下的容器规则');
      writeFileSync(join(dataRoot,selector.slice(1)+'-narrow.png'),(await captureFrame(true)).toPNG());
      assert(wide.width>620); assert(narrow.width<wide.width);
      for(const layout of [wide,narrow]) {
        assert(Math.abs(layout.width-layout.expectedWidth)<1); assert(Math.abs(layout.left-layout.expectedLeft)<1);
        assert.equal(layout.radius,'18px'); assert.equal(layout.font,'12px'); assert.equal(layout.shadow,'none'); assert.equal(layout.breathing,false);
      }
      return {wide,narrow};
    } finally { await restorePanel(); win.setBounds(bounds); await delay(220); }
  };
  const controlStyle = (selector: string) =>
    win.webContents.executeJavaScript(
      `(()=>{const style=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return {background:style.backgroundColor,color:style.color,radius:style.borderRadius,shadow:style.boxShadow,transform:style.transform};})()`,
    );
  const hoverStyle = async (selector: string, probe = selector, measure?: string) => {
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('DOM.enable');
      await win.webContents.debugger.sendCommand('CSS.enable');
      // 流式事实追赶时 React 可能替换工具行；只测量同一个仍存活的 DOM 节点。
      for(let attempt=0;attempt<3;attempt++) {
        const document = await win.webContents.debugger.sendCommand('DOM.getDocument');
        const node = await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:document.root.nodeId,selector});
        if(!node.nodeId){await delay(80);continue;}
        const original = await win.webContents.debugger.sendCommand('DOM.describeNode',{nodeId:node.nodeId});
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:node.nodeId,forcedPseudoClasses:['hover']});
        await delay(100);
        const currentDocument = await win.webContents.debugger.sendCommand('DOM.getDocument');
        const current = await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:currentDocument.root.nodeId,selector});
        if(!current.nodeId)continue;
        const observed = await win.webContents.debugger.sendCommand('DOM.describeNode',{nodeId:current.nodeId});
        if(observed.node.backendNodeId!==original.node.backendNodeId)continue;
        const style = measure ? await win.webContents.executeJavaScript(measure) : await controlStyle(probe);
        await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId:current.nodeId,forcedPseudoClasses:[]}).catch(()=>undefined);
        return style;
      }
      throw Error('悬停目标持续改变：'+selector);
    } finally {
      win.webContents.debugger.detach();
    }
  };
  try {
    const ready = await broker.ready();
    assert.equal(ready.sqlite, true);
    assert(Number(ready.node.split('.')[0]) >= 24);
    pass('真实 Electron utility process + node:sqlite', ready);
    const icon = nativeImage.createFromPath(
        join(dirname(fileURLToPath(import.meta.url)), 'renderer/umi-logo.png'),
      ),
      bitmap = icon.toBitmap(),
      size = icon.getSize();
    assert.equal(size.width, 512);
    assert.equal(size.height, 512);
    assert.equal(bitmap[3], 0);
    assert.equal(bitmap[(size.width * size.height - 1) * 4 + 3], 0);
    assert(bitmap.some((value, index) => index % 4 === 3 && value === 255));
    let whitePixels = 0;
    for (let i = 0; i < bitmap.length; i += 4)
      if (bitmap[i + 3]! >= 250 && bitmap[i]! > 240 && bitmap[i + 1]! > 240 && bitmap[i + 2]! > 240) whitePixels++;
    assert(whitePixels > 10000, '角色白色区域应保留，不能随外围背景被抠除');
    for(const [x,y] of [[256,8],[8,256],[256,504],[504,256]] as const) {
      const pixelOffset: number = (y * size.width + x) * 4;
      assert.deepEqual([...bitmap.subarray(pixelOffset,pixelOffset+4)],[255,255,255,255], '图标边缘中段应为纯白实底');
    }
    pass('应用图标512方形、白色圆角底板、角外透明，角色与蓝色元素保留');
    const ico=readFileSync(join(dirname(fileURLToPath(import.meta.url)),'renderer/umi.ico'));
    const iconSizes=[16,24,32,48,64,128,256];
    assert.equal(ico.readUInt16LE(2),1); assert.equal(ico.readUInt16LE(4),iconSizes.length);
    for (const [i,edge] of iconSizes.entries()) {
      const at=6+16*i,length=ico.readUInt32LE(at+8),offset=ico.readUInt32LE(at+12);
      assert.equal(ico[at]||256,edge); assert.equal(ico[at+1]||256,edge);
      assert(offset+length<=ico.length);
      assert.deepEqual(ico.subarray(offset,offset+length),icon.resize({width:edge,height:edge,quality:'best'}).toPNG());
    }
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('link[rel="icon"]')?.getAttribute('href')`),'./umi.ico');
    pass('网页与Windows图标共用当前单图标，ICO七种尺寸逐项匹配PNG来源');
    const workspace = join(dataRoot, 'verification-workspace');
    mkdirSync(workspace, { recursive: true });
    // 来源样本在创建工作副本前准备；后续交付必须真的改变这个文件。
    writeFileSync(join(workspace, 'delivery-preview.txt'), '交付前原文', 'utf8');
    const c = (await broker.request({
      internal: 'create_internal',
      payload: { workspace },
    })) as { conversationId: string; environmentId: string };
    const send = async (text: string) =>
      broker.request({
        type: 'send',
        conversationId: c.conversationId,
        commandId: randomUUID(),
        text,
        attachmentIds: [],
      }) as Promise<{ runId: string }>;
    const snapshot = () =>
      broker.request({
        type: 'snapshot',
        conversationId: c.conversationId,
      }) as Promise<Snapshot>;
    const r = await send('桌面批准与恢复验证');
    let state = await until(
      snapshot,
      (s) => s.state.runs[r.runId]?.status === 'waiting_permission',
    );
    assert(
      state.state.blocks.some((b) => b.kind === 'text' && b.displayRole === 'commentary'),
    );
    assert(!state.state.blocks.some((b) => b.displayRole === 'final'));
    pass('批准阻塞前可消费阶段正文，尚无最终正文');
    if (win.webContents.isLoading())
      await new Promise<void>((resolve) =>
        win.webContents.once('did-finish-load', () => resolve()),
      );
    await win.webContents.executeJavaScript(
      `localStorage.setItem('umi.work.activeThread',${JSON.stringify(c.conversationId)}); location.reload();`,
    );
    await new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    );
    await until(
      () => win.webContents.executeJavaScript(`(() => {
        const card = document.querySelector('.umi-approval[aria-label="操作批准"]');
        return !!card && card.querySelector('strong')?.textContent === '确认本次操作'
          && card.querySelector('.approval-allow')?.textContent === '允许本次'
          && card.querySelector('.approval-deny')?.textContent === '拒绝';
      })()`),
      Boolean,
    );
    pass('页面重载重建批准卡片，未停止 Agent');
    assert.equal((await snapshot()).state.runs[r.runId]?.status, 'waiting_permission');
    const bridge = await win.webContents.executeJavaScript(
      '({node:typeof window.require,bridge:typeof window.umi.request,raw:typeof window.umi.send})',
    );
    assert.deepEqual(bridge, { node: 'undefined', bridge: 'function', raw: 'undefined' });
    pass('渲染器无 Node 和任意 IPC 入口');
    const invalid = await win.webContents.executeJavaScript(
      `window.umi.request({type:'create',workspace:'C:/Windows'}).then(()=>false,()=>true)`,
    );
    assert.equal(invalid, true);
    pass('非法目录和未签发选择证据被拒绝');
    await broker.request({
      type: 'approve',
      conversationId: c.conversationId,
      approvalId: Object.keys(state.state.approvals)[0]!,
      decision: 'allow',
    });
    state = await until(snapshot, (s) => s.state.runs[r.runId]?.status === 'completed');
    assert.equal(
      readFileSync(
        join(
          dataRoot,
          'agent/environments',
          c.environmentId,
          'task/scratch/desktop-check.txt',
        ),
        'utf8',
      ),
      'Umi desktop verified',
    );
    pass('真实结构化工具批准、执行、核验与最终完成');
    await until(
      () =>
        win.webContents.executeJavaScript(
          "document.querySelector('.umi-process-toggle')?.getAttribute('aria-expanded')",
        ),
      (x) => x === 'false',
    );
    pass('完成后执行过程收纳，最终正文独立');
    const presentation = await win.webContents.executeJavaScript(
      `(()=>{const stack=document.querySelector('.message-stack'),composer=document.querySelector('.composer'),assistant=document.querySelector('.message.assistant');return {font:getComputedStyle(document.body).fontFamily,stackWidth:stack?.getBoundingClientRect().width,composerWidth:composer?.getBoundingClientRect().width,footers:document.querySelectorAll('.message-footer time').length,text:assistant?.innerText};})()`,
    );
    assert(presentation.font.includes('Segoe UI'));
    assert(presentation.stackWidth > 0);
    assert(Math.abs(presentation.stackWidth - presentation.composerWidth) < 40);
    assert(presentation.footers >= 2);
    assert(!presentation.text.includes('项操作'));
    assert(!presentation.text.includes('第 1 轮'));
    pass('消息容器、字体、悬停时间与无轮次播报', presentation);
    await win.webContents.executeJavaScript(
      `document.querySelector('.right-rail-toggle').click()`,
    );
    // 隐藏的验收窗口会节流动画帧；布局测量跳过过渡，不改变正常窗口的动画。
    await win.webContents.executeJavaScript(
      `const style=document.createElement('style');style.id='verification-layout';style.textContent='*,*::before,*::after{transition:none!important;animation:none!important}';document.head.append(style);`,
    );
    await delay(400);
    const panel = await win.webContents.executeJavaScript(
      `(()=>{const panel=document.querySelector('.delivery-panel');return {text:panel.innerText,home:!!panel.querySelector('.work-preview-home,.umi-outputs'),width:panel.getBoundingClientRect().width};})()`,
    );
    assert.equal(panel.text,''); assert.equal(panel.home,false); assert(panel.width >= 300);
    pass('右侧没有文件时保持空白，无成果首页或多余按钮',panel);

    await Promise.race([win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`),delay(500)]);
    writeFileSync(
      join(dataRoot, 'desktop-sidebar-preview.png'),
      (await captureFrame()).toPNG(),
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.right-rail-toggle').click();document.querySelector('.umi-process-toggle').click();`,
    );
    await delay(150);
    const processText = await win.webContents.executeJavaScript(
      `document.querySelector('.umi-process')?.innerText`,
    );
    assert(processText.includes('我先准备这项操作'));
    assert(!processText.includes('第 1 轮'));
    pass('执行详情按活动分段与阶段正文交替展示');
    await win.webContents.executeJavaScript(
      `document.querySelector('.umi-process-toggle').click()`,
    );
    writeFileSync(
      join(dataRoot, 'desktop-preview.png'),
      (await captureFrame(true)).toPNG(),
    );
    // 使用同一真实页面和 IPC 检查交互，不以另一个前端模拟器替代产品。
    const ui = (await broker.request({
      type: 'new_conversation',
      conversationId: c.conversationId,
    })) as { conversationId: string };
    const uiSnapshot = () =>
      broker.request({
        type: 'snapshot',
        conversationId: ui.conversationId,
      }) as Promise<Snapshot>;
    await win.webContents.executeJavaScript(
      `localStorage.setItem('umi.work.activeThread',${JSON.stringify(ui.conversationId)});localStorage.setItem('umi.theme','light');location.reload();`,
    );
    await new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `!!document.querySelector('.composer textarea:not(:disabled)')`,
        ),
      Boolean,
    );
    const code = '快速提交验证\n<span>{mode === "chat" ? "Chat" : "Work"}</span>';
    await win.webContents.executeJavaScript(
      `document.querySelector('.right-rail-toggle').click();document.querySelector('.right-rail-toggle').click();`,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')`,
      ),
      'true',
    );
    pass('右侧工作区面板可反复收起和展开');
    const beforeDraft = (await broker.request({
      type: 'list',
      archived: false,
    })) as any[];
    assert.equal(
      beforeDraft.find((row) => row.id === ui.conversationId).hasMessages,
      false,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('.workspace-conversation')).some(node=>node.innerText==='新对话')`,
      ),
      false,
    );
    await win.webContents.executeJavaScript(`document.fonts.ready`);
    const welcome = await win.webContents.executeJavaScript(`(() => {
      const heading=document.querySelector('.text-pressure'),left=document.querySelector('.left-title-toggle'),sidebar=document.querySelector('.left-sidebar'),profile=document.querySelector('.profile-trigger');
      const bounds=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
      return {text:heading.textContent,label:heading.getAttribute('aria-label'),letters:heading.querySelectorAll('[data-letter]').length,fontReady:document.fonts.check('100px "Umi Pressure"'),icons:document.querySelectorAll('.brand-logo,.umi-brandmark').length,brand:!!document.querySelector('.brand-name'),left:bounds(left),sidebar:bounds(sidebar),newChat:bounds(document.querySelector('.new-chat')),profile:bounds(profile),height:innerHeight,rightTop:document.querySelector('.right-rail-toggle').getBoundingClientRect().top};
    })()`);
    assert.equal(welcome.text,'hello'); assert.equal(welcome.label,'hello'); assert.equal(welcome.letters,5); assert(welcome.fontReady);
    assert.equal(welcome.icons,0); assert.equal(welcome.brand,false); assert(welcome.left.bottom<=welcome.sidebar.top+1);
    assert(welcome.newChat.top < welcome.sidebar.top+12); assert(welcome.height-welcome.profile.bottom<22);
    const surfaceBounds = await win.webContents.executeJavaScript(`(()=>{const s=document.querySelector('.work-surface').getBoundingClientRect(),b=document.querySelector('.right-rail-toggle').getBoundingClientRect();return {top:s.top,right:s.right,buttonTop:b.top,buttonRight:b.right};})()`);
    assert(surfaceBounds.buttonTop>=surfaceBounds.top+6 && surfaceBounds.buttonTop<=surfaceBounds.top+14);assert(surfaceBounds.right-surfaceBounds.buttonRight>=8);
    const aligned = await win.webContents.executeJavaScript(`document.querySelector('.right-rail-toggle').parentElement.classList.contains('work-surface')`); assert(aligned);
    pass('右侧控制位于工作卡片右上角，左控制和头像保持原位',welcome);
    win.showInactive();win.webContents.setBackgroundThrottling(false);
    await captureFrame(true);await delay(150);
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
    const pressure = await win.webContents.executeJavaScript(`(() => {const h=document.querySelector('.text-pressure'),r=h.getBoundingClientRect();h.dispatchEvent(new PointerEvent('pointermove',{clientX:r.left+r.width*.2,clientY:r.top+r.height*.5,bubbles:true}));return Array.from(h.children).map(n=>n.style.fontVariationSettings).join('|');})()`);
    await until(()=>win.webContents.executeJavaScript(`Array.from(document.querySelector('.text-pressure').children).map(n=>n.style.fontVariationSettings).join('|')`),value=>Boolean(value)&&value!==pressure);
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
    pass('hello离线可变字体压力动画实际改变字重和宽度');
    await win.webContents.executeJavaScript(`window.__umiMaterial=document.documentElement.dataset.material;document.documentElement.dataset.material='solid'`);
    await delay(120);writeFileSync(join(dataRoot,'welcome-preview.png'),(await captureFrame(true)).toPNG());
    await win.webContents.executeJavaScript(`window.__umiBrandTheme=document.documentElement.dataset.theme;document.documentElement.dataset.theme='dark'`);
    await delay(120);writeFileSync(join(dataRoot,'welcome-dark-preview.png'),(await captureFrame(true)).toPNG());
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme=window.__umiBrandTheme;delete window.__umiBrandTheme`);
    pass('hello与顶部导航的浅深主题截图已保存');

    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.material=window.__umiMaterial;delete window.__umiMaterial`,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.workspace-select').click()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelector('.workspace-select').getAttribute('aria-expanded')`,
        ),
      (value) => value === 'false',
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.workspace-select').click()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelector('.workspace-select').getAttribute('aria-expanded')`,
        ),
      (value) => value === 'true',
    );
    pass('工作区连续收起与展开正常，未切换当前草稿');
    await win.webContents.executeJavaScript(
      `(()=>{const ta=document.querySelector('.composer textarea');const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(code)});ta.dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelector('.composer textarea').value`,
        ),
      (value) => value === code,
    );
    await win.webContents.executeJavaScript(
      `for(let i=0;i<20;i++)document.querySelector('.new-chat').click();`,
    );
    await delay(300);
    assert.equal(
      ((await broker.request({ type: 'list', archived: false })) as any[]).length,
      beforeDraft.length,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('.composer textarea').value`,
      ),
      code,
    );
    pass('新对话 20 次连点复用空会话，原文草稿保留且不进入历史');
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('.model-button-name').innerText`,
      ),
      'DeepSeek-V4.1-Flash-1017',
    );
    pass('输入框显示官方具体版本 DeepSeek-V4.1-Flash-1017');
    const modelBounds = win.getBounds();
    for (const [id, name] of [['deepseek-v4-pro','DeepSeek-V4-Pro-0813'],['deepseek-flash','DeepSeek-V4.1-Flash-1017']] as const) {
      await win.webContents.executeJavaScript(`document.querySelector('[data-menu-trigger=model]').click()`);
      await until(() => win.webContents.executeJavaScript(`document.querySelectorAll('.model-menu-item').length`), count => count === 2);
      const catalog = await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.model-menu-item')).map(node=>({id:node.dataset.modelId,name:node.querySelector('strong').innerText}))`);
      assert.deepEqual(catalog,[{id:'deepseek-flash',name:'DeepSeek-V4.1-Flash-1017'},{id:'deepseek-v4-pro',name:'DeepSeek-V4-Pro-0813'}]);
      await win.webContents.executeJavaScript(`document.querySelector('[data-model-id="${id}"]').click()`);
      await until(uiSnapshot, snapshot => snapshot.settings.model === id);
      await until(() => win.webContents.executeJavaScript(`document.querySelector('.model-button-name').innerText`), value => value === name);
      assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.model-button').title`),name+' · API：'+id);
    }
    pass('模型菜单显示完整版本，Pro/Flash 点击切换与实际保存的 API ID 一致');
    try {
      win.setSize(1120,modelBounds.height);
      await win.webContents.executeJavaScript(`if(document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('.right-rail-toggle').click();`);
      await delay(260);
      const compact = await win.webContents.executeJavaScript(`(()=>{const name=document.querySelector('.model-button-name'),composer=document.querySelector('.composer'),send=document.querySelector('.send-button');return {text:name.innerText,width:name.clientWidth,scroll:name.scrollWidth,chat:document.querySelector('.main-area').clientWidth,right:send.getBoundingClientRect().right,composerRight:composer.getBoundingClientRect().right,label:document.querySelector('.model-button').getAttribute('aria-label')};})()`);
      assert(compact.text.includes('V4.1-Flash-1017'));assert(compact.scroll<=compact.width+1,'窄区不能省略模型日期');assert(compact.right<compact.composerRight);assert(compact.label.includes('DeepSeek-V4.1-Flash-1017'));
      writeFileSync(join(dataRoot,'model-selection-narrow.png'),(await captureFrame(true)).toPNG());
      pass('窄聊天区保留完整型号和日期，发送按钮无越界',compact);
    } finally {
      await win.webContents.executeJavaScript(`if(document.querySelector('.right-rail-toggle').getAttribute('aria-expanded')==='true')document.querySelector('.right-rail-toggle').click();`);
      win.setBounds(modelBounds);await delay(220);
    }
    const sendStyle = await controlStyle('.send-button');
    assert.equal(sendStyle.radius, '50%');
    assert.equal(sendStyle.background, 'rgb(51, 127, 237)');
    assert.equal(sendStyle.color, 'rgb(255, 255, 255)');
    assert.deepEqual(await hoverStyle('.send-button'), sendStyle);
    pass('发送按钮为圆形，悬停颜色、形状、尺寸变换和阴影均不改变', sendStyle);
    await win.webContents.executeJavaScript(
      `document.querySelector('.composer textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true}));`,
    );
    await delay(100);
    assert.equal((await uiSnapshot()).messages.length, 0);
    pass('代码纯文本粘贴与中文输入法 Enter 不误发送');
    await win.webContents.executeJavaScript(
      `(async()=>{const data=new DataTransfer();data.items.add(new File(['中文参考与 source.rs'],'source.rs',{type:'text/plain'}));const canvas=document.createElement('canvas');canvas.width=48;canvas.height=32;canvas.getContext('2d').fillRect(0,0,48,32);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));data.items.add(new File([blob],'pasted.png',{type:'image/png'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelectorAll('.composer .attachment-chip.done').length`,
        ),
      (value) => value === 2,
    );
    pass('真实文件拖放上传文本与图片，附件预览卡片恢复就绪');
    const longPaste =
      '长粘贴完整原文\n' +
      '<span>{value === "中文" ? "保持原文" : "继续"}</span>\n'.repeat(140);
    await win.webContents.executeJavaScript(
      `(()=>{const data=new DataTransfer();data.setData('text/plain',${JSON.stringify(longPaste)});document.querySelector('.composer textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));})()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelectorAll('.composer .attachment-chip.done').length`,
        ),
      (value) => value === 3,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('.composer textarea').value`,
      ),
      code,
    );
    pass('长粘贴自动变为附件，短草稿与表达式不被改写');
    await win.webContents.executeJavaScript(
      `for(let i=0;i<20;i++)document.querySelector('.composer-section').requestSubmit();`,
    );
    let uiState = await until(
      uiSnapshot,
      (s) =>
        s.messages.length > 0 &&
        Object.values(s.state.runs).some((r) => r.status === 'completed'),
    );
    assert.equal(uiState.messages.length, 1);
    assert.equal(uiState.messages[0]!.payload.content, code);
    assert.equal(uiState.messages[0]!.attachments.length, 3);
    assert.equal(Object.values(uiState.state.turns).length, 1);
    pass('真实页面 20 次快速提交仅一条消息、一个模型轮，附件保持身份');
    const pasted = uiState.messages[0]!.attachments.find(
      (a) => a.name === '已粘贴的文本.txt',
    )!;
    const pastedPreview = (await broker.request({
      type: 'read_attachment',
      conversationId: ui.conversationId,
      attachmentId: pasted.id,
      startByte: 0,
      byteLength: 64000,
    })) as { text: string };
    assert.equal(pastedPreview.text, longPaste);
    pass('长输入附件持久化保存原文，不做摘要或截断');
    await win.webContents.executeJavaScript(
      `(async()=>{document.querySelector('[data-menu-trigger=model]').click();await new Promise(resolve=>setTimeout(resolve,0));document.querySelector('.thinking-row').click();})()`,
    );
    await until(
      () => win.webContents.executeJavaScript(`document.querySelectorAll('.thinking-submenu [role=radio]').length === 3`),
      Boolean,
    );
    await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.thinking-submenu [role=radio]')).find(button => button.textContent.trim() === 'High').click();`,
    );
    uiState = await until(uiSnapshot, (s) => s.settings.thinking === 'high');
    pass('思考强度单选菜单接入真实持久化设置');
    await until(() => win.webContents.executeJavaScript(`!document.querySelector('.thinking-submenu')`), Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('.thinking-row').click();`);
    await until(() => win.webContents.executeJavaScript(`document.querySelector('.thinking-submenu [aria-checked=true]')?.textContent.trim()`), value => value === 'High');
    const thinkingStyle = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.thinking-option')).map(node=>({transform:getComputedStyle(node).transform,filter:getComputedStyle(node).filter,shadow:getComputedStyle(node).boxShadow}))`,
    );
    assert.equal(thinkingStyle.length, 3);
    assert(
      thinkingStyle.every(
        (style: any) =>
          style.transform === 'none' &&
          style.filter === 'none' &&
          style.shadow === 'none',
      ),
    );
    pass('思考选项无文字缩放、模糊滤镜和阴影');
    await win.webContents.executeJavaScript(`document.querySelector('[data-menu-trigger=model]').click();`);
    const surface = await win.webContents.executeJavaScript(
      `({material:document.documentElement.dataset.material,removed:localStorage.getItem('umi.canvasColor')===null,swatches:document.querySelectorAll('.canvas-swatch').length,title:document.querySelector('.conversation-title')?.innerText,brand:document.querySelector('.brand-button')?.innerText,pasteButton:!!document.querySelector('[aria-label="粘贴文本"]')})`,
    );
    assert(['mica', 'solid'].includes(surface.material));
    assert(surface.removed);
    assert.equal(surface.swatches, 0);
    assert(surface.title?.includes('快速提交验证'));
    assert.equal(surface.brand, undefined);
    assert.equal(surface.pasteButton, false);
    pass('原生材质或明确降级，旧底色清除，标题可见，页内品牌与旧粘贴按钮移除', surface);
    assert.equal(
      await win.webContents.executeJavaScript(
        `document.querySelector('.conversation-title').querySelectorAll('svg').length`,
      ),
      0,
    );
    await win.webContents.executeJavaScript(
      `window.__umiContrastMaterial=document.documentElement.dataset.material;document.documentElement.dataset.material='solid';document.documentElement.dataset.theme='dark'`,
    );
    try {
      const navigation = await hoverStyle(
        '.workspace-conversation-wrap:not(.active)',
        '.workspace-conversation-wrap:not(.active) .workspace-conversation',
        `(() => {
          const node=document.querySelector('.workspace-conversation-wrap:not(.active) .workspace-conversation');
          const rgba=value=>{const c=value.match(/[0-9.]+/g).map(Number);return [...c.slice(0,3),c[3]??1];};
          const layers=[];for(let p=node;p;p=p.parentElement)layers.unshift(rgba(getComputedStyle(p).backgroundColor));
          let background=[255,255,255];for(const c of layers)background=background.map((v,i)=>c[i]*c[3]+v*(1-c[3]));
          const style=getComputedStyle(node),foreground=rgba(style.color).slice(0,3);
          const luminance=c=>c.map(v=>v/255).map(v=>v<=0.04045?v/12.92:((v+0.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i],0);
          const a=luminance(foreground),b=luminance(background);
          return {color:style.color,background,contrast:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05),shadow:style.boxShadow,material:document.documentElement.dataset.material};
        })()`,
      );
      // 当前侧栏悬停是透明叠色，按真实祖先背景合成对比度，不固定要求黑字。
      assert(navigation.contrast >= 4.5, JSON.stringify(navigation));
      assert.equal(navigation.shadow, 'none');
      pass('深色主题静态降级下侧栏悬停文字对比度至少4.5，无阴影', navigation);
    } finally {
      await win.webContents.executeJavaScript(
        `document.documentElement.dataset.theme='light';document.documentElement.dataset.material=window.__umiContrastMaterial;delete window.__umiContrastMaterial`,
      );
    }
    await win.webContents.executeJavaScript(
      `(async()=>{document.querySelectorAll('.conversation-more')[0].click();await new Promise(resolve=>setTimeout(resolve,0));document.querySelector('.archive-conversation').click();})()`,
    );
    await until(
      () => win.webContents.executeJavaScript(`!!document.querySelector('.hold-button')`),
      Boolean,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.hold-button').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
    );
    await delay(250);
    await win.webContents.executeJavaScript(
      `document.querySelector('.hold-button').dispatchEvent(new KeyboardEvent('keyup',{key:'Enter',bubbles:true,cancelable:true}));`,
    );
    assert.equal(
      ((await broker.request({ type: 'list', archived: true })) as unknown[]).length,
      0,
    );
    pass('短按不归档，长按控件不以普通 click 派发');
    await win.webContents.executeJavaScript(
      `document.querySelector('.hold-button').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`,
    );
    await until(
      () => broker.request({ type: 'list', archived: true }) as Promise<any[]>,
      (rows) => rows.some((row) => row.id === ui.conversationId),
    );
    await until(
      () => win.webContents.executeJavaScript(`!document.querySelector('.umi-confirm')`),
      Boolean,
    );
    await win.webContents.executeJavaScript(
      `(async()=>{document.querySelector('.profile-trigger').click();await new Promise(resolve=>setTimeout(resolve,0));document.querySelector('.profile-menu [role=menuitem]:last-child').click();})()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelectorAll('.settings-page-nav-item').length`,
        ),
      (value) => value === 5,
    );
    const categories = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.settings-page-nav-item')).map(node=>node.innerText)`,
    );
    assert.deepEqual(categories, ['个人资料', '模型设置', '会话', '执行环境', '归档']);
    pass('设置按五个独立分类展示', categories);
    const settingsHover = await hoverStyle('.settings-page-nav-item[data-category="model"]');
    assert.equal(settingsHover.shadow,'none');assert.equal(settingsHover.background,'rgba(0, 0, 0, 0)');
    pass('设置分类悬停无投影或灰色浮起底板，深浅主题色由统一变量提供',settingsHover);
    assert.equal(
      await win.webContents.executeJavaScript(
        `getComputedStyle(document.querySelector('.app-shell')).visibility`,
      ),
      'hidden',
    );
    pass('设置打开时工作台不再绘制，不透出底层内容');
    // Chromium 截图不包含 DWM 原生材质，证据图明确使用静态降级外壳。
    await win.webContents.executeJavaScript(
      `window.__umiMaterial=document.documentElement.dataset.material;document.documentElement.dataset.material='solid'`,
    );
    await delay(100);
    writeFileSync(
      join(dataRoot, 'settings-preview.png'),
      (await captureFrame(true)).toPNG(),
    );
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.material=window.__umiMaterial;delete window.__umiMaterial`,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('[data-category=archive]').click()`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelectorAll('.archive-list button').length`,
        ),
      (value) => value > 0,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.archive-list button').click();`,
    );
    await until(
      () => broker.request({ type: 'list', archived: false }) as Promise<any[]>,
      (rows) => rows.some((row) => row.id === ui.conversationId),
    );
    pass('长按归档后可在设置恢复，原会话身份不变');
    const disposable = await broker.request({internal:'create_internal',payload:{workspace}}) as {conversationId:string;environmentId:string};
    await broker.request({type:'rename',conversationId:disposable.conversationId,title:'删除功能验收'});
    await broker.request({type:'archive',conversationId:disposable.conversationId});
    await win.webContents.executeJavaScript("document.querySelector('[data-category=profile]').click()");
    await win.webContents.executeJavaScript("document.querySelector('[data-category=archive]').click()");
    await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.archive-delete')"),Boolean);
    await win.webContents.executeJavaScript("document.querySelector('.archive-delete').click()");
    await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.archive-delete-confirm [role=dialog]')"),Boolean);
    assert((await broker.request({type:'list',archived:true}) as any[]).some(row=>row.id===disposable.conversationId));
    assert.equal(await win.webContents.executeJavaScript("document.activeElement.textContent"),'取消');
    pass('永久删除先显示范围说明并默认聚焦取消，尚不删除会话');
    await win.webContents.executeJavaScript("document.querySelector('.archive-delete-confirm button').click()");
    await until(()=>win.webContents.executeJavaScript("!document.querySelector('.archive-delete-confirm')"),Boolean);
    assert((await broker.request({type:'list',archived:true}) as any[]).some(row=>row.id===disposable.conversationId));
    pass('取消永久删除后原归档会话仍可恢复');
    await win.webContents.executeJavaScript("document.querySelector('.archive-delete').click()");
    await until(()=>win.webContents.executeJavaScript("!!document.querySelector('.archive-delete-confirm')"),Boolean);
    await win.webContents.executeJavaScript("window.__deleteMaterial=document.documentElement.dataset.material;document.documentElement.dataset.material='solid';new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    const deleteStyle=await win.webContents.executeJavaScript("(()=>{const node=document.querySelector('.archive-delete-confirm section'),s=getComputedStyle(node);return {width:node.getBoundingClientRect().width,font:getComputedStyle(node.querySelector('p')).fontSize,shadow:s.boxShadow,visible:s.visibility,topHit:!!document.elementFromPoint(node.getBoundingClientRect().x+node.getBoundingClientRect().width/2,node.getBoundingClientRect().y+node.getBoundingClientRect().height/2)?.closest('.archive-delete-confirm')};})()");
    assert(deleteStyle.width>300&&deleteStyle.width<=420);assert.equal(deleteStyle.shadow,'none');assert.equal(deleteStyle.visible,'visible');assert.equal(deleteStyle.topHit,true,'删除确认框必须位于设置页上方并可点击');
    await delay(100);
    writeFileSync(join(dataRoot,'archive-delete-preview.png'),(await captureFrame(true)).toPNG());
    await win.webContents.executeJavaScript("document.documentElement.dataset.material=window.__deleteMaterial;delete window.__deleteMaterial");
    await win.webContents.executeJavaScript("localStorage.setItem('umi.pending.'+"+JSON.stringify(disposable.conversationId)+",'测试待发草稿');localStorage.setItem('umi.feedback.'+"+JSON.stringify(disposable.conversationId)+"+'.message','like')");
    await win.webContents.executeJavaScript("document.querySelector('.archive-delete-confirm .archive-delete').click()");
    await until(()=>broker.request({type:'list',archived:true}) as Promise<any[]>,rows=>!rows.some(row=>row.id===disposable.conversationId));
    await until(()=>win.webContents.executeJavaScript("!document.querySelector('.archive-delete-confirm')"),Boolean);
    await assert.rejects(()=>broker.request({type:'snapshot',conversationId:disposable.conversationId}),/会话不存在/);
    assert(!existsSync(join(dataRoot,'agent','environments',disposable.environmentId)));
    pass('确认永久删除后数据库会话与托管目录消失，原工作区源文件保留');
    assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('umi.pending.'+"+JSON.stringify(disposable.conversationId)+")"),null);
    assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('umi.feedback.'+"+JSON.stringify(disposable.conversationId)+"+'.message')"),null);
    pass('永久删除清除本会话待发草稿与本机反馈');
    await broker.request({
      type: 'send',
      conversationId: ui.conversationId,
      commandId: randomUUID(),
      text: '滚动验证',
      attachmentIds: [],
    });
    uiState = await until(
      uiSnapshot,
      (s) =>
        Object.values(s.state.runs).filter((r) => r.status === 'completed').length === 2,
    );
    await win.webContents.executeJavaScript(
      `localStorage.setItem('umi.work.activeThread',${JSON.stringify(ui.conversationId)});localStorage.setItem('umi.theme','light');location.reload();`,
    );
    await new Promise<void>((resolve) =>
      win.webContents.once('did-finish-load', () => resolve()),
    );
    await until(
      () => win.webContents.executeJavaScript(`document.body.innerText`),
      (text) => text.includes('这是第 80 段'),
    );
    await win.webContents.executeJavaScript(
      `const canvas=document.querySelector('.chat-canvas');canvas.scrollTop=0;canvas.dispatchEvent(new Event('scroll'));`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `!!document.querySelector('.scroll-to-bottom')`,
        ),
      Boolean,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.scroll-to-bottom').click();`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(`!document.querySelector('.scroll-to-bottom')`),
      Boolean,
    );
    pass('回到底部按真实滚动距离显示，点击后回到最新消息');
    const shadows = await win.webContents.executeJavaScript(
      `Array.from(document.querySelectorAll('.umi-process-toggle,.umi-activity-toggle,.umi-tool-toggle,.meta-button,.send-button,.sidebar-toggle')).map(button=>getComputedStyle(button).boxShadow)`,
    );
    assert(shadows.every((shadow: string) => shadow === 'none'));
    pass('消息展开、复制、发送与侧栏按钮统一无阴影');
    const footer = await win.webContents.executeJavaScript(
      `(()=>{const user=document.querySelector('.message.user'),bubble=user.querySelector('.message-body').getBoundingClientRect(),foot=user.querySelector('.message-footer'),r=foot.getBoundingClientRect();return {direction:getComputedStyle(foot).flexDirection,bubbleRight:bubble.right,footerRight:r.right,transform:getComputedStyle(foot).transform};})()`,
    );
    assert.equal(footer.direction, 'row');
    assert(Math.abs(footer.footerRight - footer.bubbleRight) < 5);
    assert.equal(footer.transform, 'none');
    pass('用户消息底部对齐气泡右缘，无位移动画', footer);
    writeFileSync(
      join(dataRoot, 'interaction-preview.png'),
      (await captureFrame(true)).toPNG(),
    );
    const longTyped = '手写长消息完整原文：' + '保留所有用户要求。'.repeat(800);
    await win.webContents.executeJavaScript(
      `(()=>{const textarea=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(textarea,${JSON.stringify(longTyped)});textarea.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await delay(50);
    await win.webContents.executeJavaScript(
      `for(let i=0;i<20;i++)document.querySelector('.composer-section').requestSubmit();`,
    );
    uiState = await until(
      uiSnapshot,
      (s) =>
        s.messages.length === 3 &&
        Object.values(s.state.runs).filter((r) => r.status === 'completed').length === 3,
    );
    const typedMessage = uiState.messages.at(-1)!;
    assert(typedMessage.payload.content.includes('完整用户消息'));
    assert.equal(typedMessage.attachments.length, 1);
    const typedPreview = (await broker.request({
      type: 'read_attachment',
      conversationId: ui.conversationId,
      attachmentId: typedMessage.attachments[0]!.id,
      startByte: 0,
      byteLength: 64000,
    })) as { text: string };
    assert.equal(typedPreview.text, longTyped);
    pass('手写长消息发送前转原文附件，20 次连点仍只提交一次');
    const delivery = (await broker.request({
      type: 'send',
      conversationId: ui.conversationId,
      commandId: randomUUID(),
      text: '交付卡片验证',
      attachmentIds: [],
    })) as { runId: string };
    await until(
      uiSnapshot,
      (s) => s.state.runs[delivery.runId]?.status === 'waiting_permission',
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelector('.delivery-file-list')?.innerText`,
        ),
      (text) => typeof text === 'string' && text.includes('delivery-preview.txt'),
    );
    const approvalCard = await win.webContents.executeJavaScript(
      `document.querySelector('.umi-approval').innerText`,
    );
    assert(approvalCard.length < 600);
    assert(!approvalCard.includes('冻结预览正文'));
    assert(!approvalCard.includes('beforeContentHash'));
    pass('真实交付批准仅显示冻结文件范围，不显示 JSON 或整篇正文');
    // 批准等待使用独立卡片；停止样式在下方真正运行中的任务验证。
    assert.equal(await win.webContents.executeJavaScript(
      `document.querySelectorAll('.composer-approval input,.composer-approval textarea,.composer-approval .send-button.stop').length`), 0);
    assert.equal(readFileSync(join(workspace, 'delivery-preview.txt'), 'utf8'), '交付前原文');
    const approvalLayout = await composerSize('.composer-approval');
    assert(approvalLayout.wide.height<330); assert(approvalLayout.narrow.height<380);
    writeFileSync(join(dataRoot,'approval-matched-preview.png'),(await captureFrame(true)).toPNG());
    pass('批准卡与输入框在宽窄布局中等宽对齐，18px圆角、12px字体，无等待动画',approvalLayout);
    await win.webContents.executeJavaScript(
      `document.querySelector('.delivery-file-list button').click();`,
    );
    await until(
      () =>
        win.webContents.executeJavaScript(
          `document.querySelector('.file-preview-scroll')?.textContent`,
        ),
      (text) => typeof text === 'string' && text.includes('冻结预览正文'),
    );
    assert.equal(
      (await uiSnapshot()).state.runs[delivery.runId]?.status,
      'waiting_permission',
    );
    const preview = await win.webContents.executeJavaScript(`(() => {const body=document.querySelector('.file-preview-scroll');return {mode:body.dataset.mode,text:body.textContent,overflow:body.scrollWidth<=body.clientWidth+1,extras:!!document.querySelector('.preview-version,.preview-notice,.code-diff,.work-preview-status'),modes:Array.from(document.querySelectorAll('.file-view-options button')).map(n=>n.textContent),path:document.querySelector('.file-preview-path').textContent};})()`);
    assert.equal(preview.mode,'preview'); assert(preview.text.includes('冻结预览正文')); assert(preview.overflow); assert.equal(preview.extras,false); assert.deepEqual(preview.modes,['原文','预览']); assert.equal(preview.path,join(workspace,'delivery-preview.txt'));
    pass('冻结文件默认展示结果预览，仅原文/预览两种模式，无版本和分页杂项，预览不推进批准',preview);
    await delay(500);
    await Promise.race([win.webContents.executeJavaScript(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`),delay(500)]);
    await win.webContents.executeJavaScript(
      `window.__umiMaterial=document.documentElement.dataset.material;document.documentElement.dataset.material='solid'`,
    );
    await delay(100);
    writeFileSync(
      join(dataRoot, 'delivery-preview.png'),
      (await captureFrame(true)).toPNG(),
    );
    await win.webContents.executeJavaScript(
      `document.documentElement.dataset.material=window.__umiMaterial;delete window.__umiMaterial`,
    );
    await win.webContents.executeJavaScript(
      `document.querySelector('.umi-approval-actions .approval-allow').click();`,
    );
    const deliveredState = await until(uiSnapshot, (s) => s.state.runs[delivery.runId]?.status === 'completed');
    assert(Object.values(deliveredState.state.tools).some(tool => tool.runId === delivery.runId && tool.name === 'deliver_changeset' && tool.status === 'succeeded'));
    assert.equal(readFileSync(join(workspace, 'delivery-preview.txt'), 'utf8'), '冻结预览正文。'.repeat(300));
    pass('真实 UI 允许本次后成功交付，来源完整写回并有成功工具回执');
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.umi-changes')`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('.umi-changes').open=true`);
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.umi-changes .umi-file-row')`),Boolean);
    const fileLinkHover = await hoverStyle('.umi-changes .umi-file-row');
    const linkColor=fileLinkHover.color.match(/[\d.]+/g).map(Number);assert(linkColor[2]>linkColor[0]+50);assert.equal(fileLinkHover.shadow,'none');assert.equal(fileLinkHover.background,'rgba(0, 0, 0, 0)');
    pass('可预览文件入口使用主题蓝色，悬停无阴影或灰色卡片底板',fileLinkHover);
    const events = (await broker.request({
      type: 'events',
      conversationId: c.conversationId,
      cursor: {
        streamId: c.conversationId,
        logEpoch: state.state.cursor.logEpoch,
        sequence: '0',
      },
    })) as { events: any[] };
    let replay = initialState(c.conversationId, state.state.cursor.logEpoch);
    for (const event of events.events) replay = reduceConversation(replay, event);
    assert.deepEqual(replay, state.state);
    pass('实际 IPC 事件重放与历史快照一致');
    const command = await send('验证命令');
    state = await until(
      snapshot,
      (s) => s.state.runs[command.runId]?.status === 'waiting_permission',
    );
    const pending = Object.entries(state.state.approvals).find(
      ([, a]) => a.status === 'pending',
    )!;
    await broker.request({
      type: 'approve',
      conversationId: c.conversationId,
      approvalId: pending[0],
      decision: 'allow',
    });
    state = await until(snapshot, (s) =>
      ['completed', 'failed'].includes(s.state.runs[command.runId]?.status ?? ''),
    );
    assert.equal(state.state.runs[command.runId]?.status, 'completed');
    assert(
      Object.values(state.state.tools).some(
        (t) => t.name === 'run_command' && t.status === 'succeeded',
      ),
    );
    pass('Electron 内调用真正 Node 程序，Windows Job 与输出回执可用');
    const failing=await send('验证命令（失败）');
    let failedState=await until(snapshot,s=>s.state.runs[failing.runId]?.status==='waiting_permission');
    const failedApproval=Object.entries(failedState.state.approvals).find(([,a])=>a.status==='pending'&&failedState.state.tools[a.callId]?.runId===failing.runId)!;
    await broker.request({type:'approve',conversationId:c.conversationId,approvalId:failedApproval[0],decision:'allow'});
    failedState=await until(snapshot,s=>['completed','failed'].includes(s.state.runs[failing.runId]?.status??''));
    assert(Object.values(failedState.state.tools).some(t=>t.runId===failing.runId&&t.status==='failed'));
    await win.webContents.executeJavaScript(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(c.conversationId)});location.reload();`);
    await new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[data-run-id="${failing.runId}"] .umi-process-toggle')`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('[data-run-id="${failing.runId}"] .umi-process-toggle').click();`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('[data-run-id="${failing.runId}"] .umi-activity-toggle').length>0`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelectorAll('[data-run-id="${failing.runId}"] .umi-activity-toggle').forEach(button=>button.click());`);
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('[data-run-id="${failing.runId}"] [data-outcome=failed]')`),Boolean);
    const failureStyle=await win.webContents.executeJavaScript(`(()=>{const node=document.querySelector('[data-run-id="${failing.runId}"] [data-outcome=failed]');return {color:getComputedStyle(node).color,status:node.getAttribute('aria-label'),badges:node.querySelectorAll('small').length};})()`);
    const failureColor=failureStyle.color.match(/[\d.]+/g).map(Number);assert(failureColor[0]>failureColor[1]+70);assert.equal(failureStyle.badges,0);assert(failureStyle.status.includes('失败'));
    writeFileSync(join(dataRoot,'failed-command-preview.png'),(await captureFrame(true)).toPNG());
    pass('真实失败命令使用红色文本，无侧边失败徽标，状态仍保留在无障碍与详情中',failureStyle);
    const failedHover = await hoverStyle(`[data-run-id="${failing.runId}"] [data-outcome=failed]`);
    assert.equal(failedHover.shadow,'none');assert.equal(failedHover.background,'rgba(0, 0, 0, 0)');
    pass('失败操作悬停保持平面红字，无投影或高亮底板',failedHover);
    const running = await send('等待停止');
    await until(snapshot, (s) =>
      s.state.blocks.some(
        (b) => b.runId === running.runId && b.text === '任务仍在运行。',
      ),
    );
    await win.webContents.executeJavaScript(
      `localStorage.setItem('umi.work.activeThread',${JSON.stringify(c.conversationId)}); location.reload();`,
    );
    await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
    await until(() => win.webContents.executeJavaScript(`!!document.querySelector('.send-button.stop')`), Boolean);
    win.webContents.debugger.attach('1.3');
    try {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
      const breathing = await until(()=>win.webContents.executeJavaScript(`(()=>{const edge=document.querySelector('.composer-breathing');if(!edge)return null;const style=getComputedStyle(edge);return {opacity:style.opacity,animation:style.animationName,duration:style.animationDuration,border:style.borderColor,radius:style.borderRadius,parentRadius:getComputedStyle(edge.parentElement).borderRadius,canvas:edge.parentElement.querySelectorAll('canvas').length};})()`),value=>Boolean(value));
      assert.equal(breathing.animation,'composer-breathe');assert.equal(breathing.duration,'3.2s');assert.equal(breathing.border,'rgb(46, 127, 235)');assert.equal(breathing.radius,breathing.parentRadius);assert.equal(breathing.canvas,0);
      await until(()=>win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.composer-breathing')).opacity`),value=>Math.abs(Number(value)-Number(breathing.opacity))>.03);
      writeFileSync(join(dataRoot,'breathing-running-preview.png'),(await captureFrame(true)).toPNG());
      pass('真实运行期间蓝色圆角边缘缓慢呼吸，不使用canvas，不影响输入布局',breathing);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      const staticEdge=await until(()=>win.webContents.executeJavaScript(`(()=>{const style=getComputedStyle(document.querySelector('.composer-breathing'));return {animation:style.animationName,opacity:style.opacity};})()`),value=>value.animation==='none');
      await delay(200);assert.equal(await win.webContents.executeJavaScript(`getComputedStyle(document.querySelector('.composer-breathing')).opacity`),staticEdge.opacity);
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});
      pass('减少动态偏好下保留静态蓝色边缘，呼吸动画关闭',staticEdge);
      await win.webContents.debugger.sendCommand('DOM.enable');
      await win.webContents.debugger.sendCommand('CSS.enable');
      const document = await win.webContents.debugger.sendCommand('DOM.getDocument');
      const node = await win.webContents.debugger.sendCommand('DOM.querySelector', {
        nodeId: document.root.nodeId,
        selector: '.send-button.stop',
      });
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {
        nodeId: node.nodeId,
        forcedPseudoClasses: ['hover'],
      });
      await delay(180);
      const hover = await win.webContents.executeJavaScript(
        `(()=>{const style=getComputedStyle(document.querySelector('.send-button.stop'));return {shadow:style.boxShadow,radius:style.borderRadius,background:style.backgroundColor};})()`,
      );
      assert.deepEqual(hover, {
        shadow: 'none',
        radius: '50%',
        background: 'rgb(230, 50, 64)',
      });
      pass('中止按钮悬停保留圆形及红白颜色，无阴影', hover);
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState', {
        nodeId: node.nodeId,
        forcedPseudoClasses: [],
      });
    } finally {
      win.webContents.debugger.detach();
    }
    win.hide();
    assert.equal((await snapshot()).state.runs[running.runId]?.status, 'running');
    pass('窗口隐藏不会停止任务');
    broker.killForVerification();
    await delay(250);
    const restarted = await broker.ready();
    assert.notEqual(restarted.instanceId, ready.instanceId);
    state = await snapshot();
    assert.equal(state.state.runs[running.runId]?.status, 'interrupted');
    await until(()=>win.webContents.executeJavaScript(`!document.querySelector('.composer-breathing')`),Boolean);
    assert(
      !state.state.blocks.some(
        (b) => b.runId === running.runId && b.status === 'running',
      ),
    );
    pass('真实子进程强制退出后重新就绪，部分响应转为中断，不自动续跑');
    await broker.request({
      type: 'stop',
      conversationId: c.conversationId,
      runId: running.runId,
    });
    assert.equal((await snapshot()).state.runs[running.runId]?.status, 'stopped');
    pass('显式停止与崩溃、窗口关闭分别记录');
    const a = (await broker.request({
      type: 'upload_attachment',
      conversationId: c.conversationId,
      name: 'reference.txt',
      mime: 'text/plain',
      text: '资料原文',
    })) as { id: string };
    await broker.request({
      type: 'send',
      conversationId: c.conversationId,
      commandId: randomUUID(),
      text: '读取附件',
      attachmentIds: [a.id],
    });
    state = await snapshot();
    assert(
      state.messages.some(
        (m) =>
          m.attachments.some((x) => x.id === a.id) && m.payload.content === '读取附件',
      ),
    );
    pass('附件身份保留，不把正文塞入用户消息');
    const budgetConversation = (await broker.request({
      type: 'new_conversation',
      conversationId: c.conversationId,
    })) as { conversationId: string };
    const budgetSnapshot = () =>
      broker.request({
        type: 'snapshot',
        conversationId: budgetConversation.conversationId,
      }) as Promise<Snapshot>;
    const initial = await budgetSnapshot();
    await broker.request({
      type: 'settings',
      conversationId: budgetConversation.conversationId,
      settings: { ...initial.settings, contextWindow: 128000 },
    });
    const budgetRun = (await broker.request({
      type: 'send',
      conversationId: budgetConversation.conversationId,
      commandId: randomUUID(),
      text: '完整预算原文'.repeat(16000),
      attachmentIds: [],
    })) as { runId: string };
    let budgetState = await until(budgetSnapshot, (s) =>
      Boolean(s.state.runs[budgetRun.runId]?.budgetBlock),
    );
    const recovery = (await broker.request({
      type: 'recovery',
      conversationId: budgetConversation.conversationId,
      runId: budgetRun.runId,
    })) as { budget: { canResume: boolean } };
    assert.equal(recovery.budget.canResume, false);
    await assert.rejects(
      () =>
        broker.request({
          type: 'resume',
          conversationId: budgetConversation.conversationId,
          runId: budgetRun.runId,
        }),
      /超过预算|阻塞/,
    );
    assert.equal(
      (await budgetSnapshot()).state.cursor.sequence,
      budgetState.state.cursor.sequence,
    );
    pass('真实桌面 IPC 识别预算阻塞，条件未变不重复派发');
    await broker.request({
      type: 'settings',
      conversationId: budgetConversation.conversationId,
      settings: { ...initial.settings, contextWindow: 1000000 },
    });
    await broker.request({
      type: 'resume',
      conversationId: budgetConversation.conversationId,
      runId: budgetRun.runId,
    });
    budgetState = await until(
      budgetSnapshot,
      (s) =>
        !s.state.runs[budgetRun.runId]?.budgetBlock &&
        s.state.blocks.some((b) => b.runId === budgetRun.runId),
    );
    pass('调整有效预算后原 run 继续，新的请求预检通过才解除阻塞');
    win.showInactive(); // 上一节核验了隐藏行为；恢复合成器后再采集问答截图。
    // 问答继续使用真实工具、持久回答和同一Agent循环，不向页面伪造业务状态。
    const questionConversation = await broker.request({type:'new_conversation',conversationId:ui.conversationId}) as {conversationId:string};
    const questionRun = await broker.request({type:'send',conversationId:questionConversation.conversationId,commandId:randomUUID(),text:'紧凑问答验证',attachmentIds:[]}) as {runId:string};
    await win.webContents.executeJavaScript(`localStorage.setItem('umi.work.activeThread',${JSON.stringify(questionConversation.conversationId)});location.reload();`);
    await new Promise<void>(resolve=>win.webContents.once('did-finish-load',()=>resolve()));
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.umi-question')`),Boolean);
    const questionWidths=await composerSize('.composer-question');
    const questionLayout=await win.webContents.executeJavaScript(`(()=>{const card=document.querySelector('.composer-question'),body=card.querySelector('.umi-question-body'),r=card.getBoundingClientRect();return {width:r.width,height:r.height,radius:getComputedStyle(card).borderRadius,fieldsets:card.querySelectorAll('fieldset').length,scroll:body.scrollHeight>body.clientHeight+1,progress:card.querySelector('.umi-question-header').innerText};})()`);
    assert(questionLayout.height<360);assert.equal(questionLayout.radius,'18px');assert.equal(questionLayout.fieldsets,1);assert.equal(questionLayout.scroll,false);assert(questionLayout.progress.includes('1 / 2'));
    writeFileSync(join(dataRoot,'question-preview.png'),(await captureFrame(true)).toPNG());
    pass('选项卡逐问呈现，宽窄布局均与输入框等宽，无内部滚动、字体紧凑',{questionLayout,questionWidths});
    await win.webContents.executeJavaScript(`document.querySelector('.umi-question input[type=radio]').click();`);
    await until(()=>win.webContents.executeJavaScript(`!Array.from(document.querySelectorAll('.umi-question-actions button')).find(b=>b.textContent.includes('下一问')).disabled`),Boolean);
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.umi-question-actions button')).find(b=>b.textContent.includes('下一问')).click();`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.umi-question legend')?.textContent`),text=>text==='报告需要哪些补充？');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.umi-question input[type=radio]')).at(-1).click();`);
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.umi-question textarea')`),Boolean);
    await win.webContents.executeJavaScript(`const input=document.querySelector('.umi-question textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留详细证据');input.dispatchEvent(new Event('input',{bubbles:true}));`);
    await until(()=>win.webContents.executeJavaScript(`!Array.from(document.querySelectorAll('.umi-question-actions button')).find(b=>b.textContent.includes('提交回答'))?.disabled`),Boolean);
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.umi-question-actions button')).find(b=>b.textContent.includes('提交回答')).click();`);
    const questionState=await until(()=>broker.request({type:'snapshot',conversationId:questionConversation.conversationId}) as Promise<Snapshot>,s=>s.state.runs[questionRun.runId]?.status==='completed');
    const answered=Object.values(questionState.state.questions??{}).find(q=>q.runId===questionRun.runId);
    assert.equal(answered?.status,'answered');assert.equal(answered?.answers?.[1]?.text,'保留详细证据');
    pass('问答翻页、自定义输入与最终提交沿真实持久记录完成');
    await until(()=>win.webContents.executeJavaScript(`!!document.querySelector('.message.assistant .message-actions')`),Boolean);
    const actions=await win.webContents.executeJavaScript(`(()=>{const root=document.querySelector('.message.assistant .message-actions');const up=root.querySelector('[aria-label="有帮助（仅本机）"]'),down=root.querySelector('[aria-label="需要改进（仅本机）"]');up.click();return root.querySelectorAll('button').length;})()`);
    assert.equal(actions,5);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.message.assistant [aria-label="有帮助（仅本机）"]').getAttribute('aria-pressed')`),s=>s==='true');
    await win.webContents.executeJavaScript(`document.querySelector('.message.assistant [aria-label="需要改进（仅本机）"]').click();`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.message.assistant [aria-label="有帮助（仅本机）"]').getAttribute('aria-pressed')==='false'&&document.querySelector('.message.assistant [aria-label="需要改进（仅本机）"]').getAttribute('aria-pressed')==='true'`),Boolean);
    await win.webContents.executeJavaScript(`document.querySelector('.message.assistant [aria-label="重新组织回答"]').click();`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.composer textarea').value`),text=>text.includes('不重复执行已完成的操作'));
    assert.equal((await broker.request({type:'snapshot',conversationId:questionConversation.conversationId}) as Snapshot).messages.length,questionState.messages.length);
    writeFileSync(join(dataRoot,'message-actions-preview.png'),(await captureFrame(true)).toPNG());
    pass('消息五个操作实际可用，赞踩互斥；重新回答先填草稿，不自动重跑工具');
    const previewFixtures = filePreviewFixtures();
    await win.webContents.executeJavaScript(`(() => {const files=${JSON.stringify(previewFixtures)};const data=new DataTransfer();for(const f of files)data.items.add(new File([f.text],f.name,{type:'text/plain'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.attachment-chip.done').length`),n=>n===previewFixtures.length);
    const openFixture = async (name: string) => { await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.attachment-name')).find(n=>n.textContent===${JSON.stringify(name)}).click()`); await until(()=>win.webContents.executeJavaScript(`document.querySelector('.file-preview-path')?.textContent`),text=>typeof text==='string' && text.endsWith(name)); await until(()=>win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll')?.getAttribute('aria-busy')`),busy=>busy==='false'); };
    await openFixture('guide.md');
    const markdown = await win.webContents.executeJavaScript(`(() => {const body=document.querySelector('.file-preview-scroll');return {heading:body.querySelector('h1')?.textContent,table:!!body.querySelector('table'),color:!!body.querySelector('.hljs-keyword'),overflow:body.scrollWidth<=body.clientWidth+1,icon:document.querySelector('.work-preview-tab.active img').getAttribute('src'),iconLoaded:document.querySelector('.work-preview-tab.active img').naturalWidth};})()`);
    assert.equal(markdown.heading,'文件预览');assert(markdown.table&&markdown.color&&markdown.overflow);assert(markdown.icon.includes('/markdown.svg'));assert(markdown.iconLoaded>0);
    pass('Markdown 默认排版、表格与代码着色；官方图标本地加载，无横向滚动',markdown);
    { await win.webContents.executeJavaScript(`document.documentElement.dataset.material='solid'`); await delay(300);writeFileSync(join(dataRoot,'file-markdown-preview.png'),(await captureFrame(true)).toPNG()); }
    await win.webContents.executeJavaScript(`document.querySelector('.file-options-menu summary').click();document.querySelector('.file-view-options button').click()`);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll code').textContent`),previewFixtures[0]!.text);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('.file-preview-scroll h1').length`),0);
    await win.webContents.executeJavaScript(`document.querySelector('.file-options-menu summary').click();document.querySelector('.file-view-options button:last-child').click();document.querySelector('[aria-label="重新加载"]').click()`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.file-markdown h1')?.textContent`),text=>text==='文件预览');
    pass('原文保留全部字符；预览切换和重新加载实际可用');
    await openFixture('app.ts');
    const codePreview = await win.webContents.executeJavaScript(`(() => {const body=document.querySelector('.file-preview-scroll');return {text:body.querySelector('code').textContent,tokens:body.querySelectorAll('[class^="hljs-"]').length,unsafe:!!body.querySelector('img'),overflow:body.scrollWidth<=body.clientWidth+1,background:getComputedStyle(body.querySelector('pre')).backgroundColor,border:getComputedStyle(body.querySelector('pre')).borderWidth};})()`);
    assert.equal(codePreview.text,previewFixtures[1]!.text);assert(codePreview.tokens>10);assert.equal(codePreview.unsafe,false);assert(codePreview.overflow);assert.equal(codePreview.border,'0px');
    pass('TypeScript 多色高亮、长行折行且保留原文，不把代码作为 HTML 执行',codePreview);
    await delay(200);writeFileSync(join(dataRoot,'file-code-preview.png'),(await captureFrame(true)).toPNG());
    await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='dark'`);await delay(200);writeFileSync(join(dataRoot,'file-code-dark-preview.png'),(await captureFrame(true)).toPNG());await win.webContents.executeJavaScript(`document.documentElement.dataset.theme='light'`);
    await win.webContents.executeJavaScript(`document.querySelector('.file-options-menu summary').click();document.querySelector('.file-view-options button').click()`);
    assert((await win.webContents.executeJavaScript(`document.querySelectorAll('.file-preview-scroll .hljs-keyword').length`))>0);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll code').textContent`),previewFixtures[1]!.text);
    pass('代码原文同样按语言着色，全部字符原样保留');
    await openFixture('ledger.jsonl');
    assert((await win.webContents.executeJavaScript(`document.querySelectorAll('.file-preview-scroll [class^="hljs-"]').length`))>0);
    pass('JSONL 文件识别为 JSON 着色，不再作为无色普通文本');
    await openFixture('page.html');
    await until(async()=>win.webContents.mainFrame.frames.some(frame=>frame.url==='about:srcdoc'),Boolean);
    // 内容 CSP 禁止脚本，因此不能用 executeJavaScript 向内容页注入验收脚本。
    // 通过 Chromium 的 DOM 观察通道读取实际子页面，不削弱产品 CSP。
    await captureFrame(true); await delay(350);
    win.webContents.debugger.attach('1.3');
    let htmlSnapshot: any;
    try {
      htmlSnapshot = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot',{computedStyles:[]});
      if (!htmlSnapshot.documents.some((doc: any)=>htmlSnapshot.strings[doc.documentURL]==='about:srcdoc')) {
        // sandbox srcdoc 在 Chromium 中可能是独立渲染进程，需要连接它的只读调试会话。
        const targets = await win.webContents.debugger.sendCommand('Target.getTargets');
        const child = targets.targetInfos.find((target: any)=>target.type==='iframe'&&target.url==='about:srcdoc');
        assert(child,'HTML 子进程应存在');
        const {sessionId} = await win.webContents.debugger.sendCommand('Target.attachToTarget',{targetId:child.targetId,flatten:true});
        htmlSnapshot = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot',{computedStyles:[]},sessionId);
      }
    } finally { win.webContents.debugger.detach(); }
    writeFileSync(join(dataRoot,'html-dom-snapshot.json'),JSON.stringify(htmlSnapshot));
    const strings = htmlSnapshot.strings as string[];
    const frameDocument = htmlSnapshot.documents.find((doc: any)=>strings[doc.documentURL]==='about:srcdoc');
    assert(frameDocument,'应能观察实际 HTML 子页面');
    const nodeNames = frameDocument.nodes.nodeName.map((index: number)=>strings[index]);
    const nodeText = frameDocument.nodes.nodeValue.map((index: number)=>strings[index]).join('');
    assert(frameDocument.layout.nodeIndex.length>3,'HTML 应完成可见排版');
    const responsiveHtml = await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('.file-html-preview'),v=document.querySelector('.file-html-viewport');return {frame:parseFloat(f.style.width),viewport:v.clientWidth};})()`);assert(Math.abs(responsiveHtml.frame-responsiveHtml.viewport)<1);
    assert(nodeText.includes('HTML 静态文件预览'));assert(!nodeNames.includes('SCRIPT'));assert(!nodeText.includes('__previewExecuted'));
    assert(!frameDocument.nodes.attributes.some((attrs: number[])=>attrs.some(index=>strings[index]==='href')));
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.file-html-preview').getAttribute('sandbox')`),'');
    assert.equal(await win.webContents.executeJavaScript(`typeof document.querySelector('.file-html-preview').contentWindow.umi`).catch(()=> 'cross-origin'),'cross-origin');
    pass('HTML 实际子页面保留静态排版；无脚本、无导航、无同源桥访问');
    await delay(200);writeFileSync(join(dataRoot,'file-html-preview.png'),(await captureFrame(true)).toPNG());
    await openFixture('fixed.html');
    const fittedHtml = await win.webContents.executeJavaScript(`(()=>{const f=document.querySelector('.file-html-preview'),v=document.querySelector('.file-html-viewport');return {frame:parseFloat(f.style.width),shown:f.getBoundingClientRect().width,viewport:v.clientWidth};})()`);
    assert(fittedHtml.frame>=1280);assert(Math.abs(fittedHtml.shown-fittedHtml.viewport)<1);
    pass('响应式 HTML 保留实际视口与自然字号，固定宽度 HTML 才等比例适应',{responsiveHtml,fittedHtml});
    const headerLayout = await win.webContents.executeJavaScript(`(()=>{const title=document.querySelector('.topbar').getBoundingClientRect(),tabs=document.querySelector('.work-preview-tabs').getBoundingClientRect(),toggle=document.querySelector('.right-rail-toggle').getBoundingClientRect(),lastTab=document.querySelector('.work-preview-tab:last-child').getBoundingClientRect(),path=document.querySelector('.file-preview-path').getBoundingClientRect(),tools=document.querySelector('.file-preview-tools').getBoundingClientRect();return {chatLine:title.bottom,tabLine:tabs.bottom,buttonLeft:toggle.left,tabRight:lastTab.right,pathY:path.top,toolsY:tools.top};})()`);
    assert(Math.abs(headerLayout.chatLine-headerLayout.tabLine)<1);assert(headerLayout.tabRight<=headerLayout.buttonLeft);assert(Math.abs(headerLayout.pathY-headerLayout.toolsY)<8);
    pass('聊天标题与标签分隔线同高，右收起按钮不覆盖标签，路径和查看控件同一行',headerLayout);
    await win.webContents.executeJavaScript(`document.querySelector('.file-options-menu summary').click()`);
    const menuLayout = await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.file-options-card'),s=getComputedStyle(c);return {radius:s.borderRadius,shadow:s.boxShadow,rect:c.getBoundingClientRect().toJSON(),width:innerWidth};})()`);
    assert.equal(menuLayout.shadow,'none');assert.equal(menuLayout.radius,'9px');assert(menuLayout.rect.right<=menuLayout.width);
    writeFileSync(join(dataRoot,'file-options-preview.png'),(await captureFrame(true)).toPNG());
    await win.webContents.executeJavaScript(`document.querySelector('.file-options-menu').open=false`);
    pass('查看与打开方式共用紧凑菜单卡片，四角和无阴影规则统一',menuLayout);
    await win.webContents.executeJavaScript(`document.getElementById('verification-layout')?.remove();window.__dragEvents=[];window.__dragTrace=e=>window.__dragEvents.push([e.type,e.pointerId,e.buttons,e.target.className]);for(const type of ['pointerdown','pointermove','pointerup','mouseup','pointercancel','lostpointercapture'])window.addEventListener(type,window.__dragTrace,true);window.__dragWrites=0;window.__storageSet=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(key==='umi.work.rightWidth')window.__dragWrites++;return window.__storageSet.call(this,key,value)};window.__iframeChanges=0;window.__iframeObserver=new MutationObserver(records=>{window.__iframeChanges+=records.filter(r=>r.attributeName==='srcdoc').length});window.__iframeObserver.observe(document.querySelector('.file-html-preview'),{attributes:true});`);
    const grip = await win.webContents.executeJavaScript(`(()=>{const r=document.querySelector('.work-preview-resizer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',x:grip.x,y:grip.y});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:grip.x,y:grip.y});await delay(30);
    for(let i=0;i<36;i++){win.webContents.sendInputEvent({type:'mouseMove',button:'left',modifiers:['leftbuttondown'],x:grip.x-i*13,y:grip.y});await delay(8);}
    await delay(50);
    const duringDrag = await win.webContents.executeJavaScript(`({writes:window.__dragWrites,resizing:document.querySelector('.app-shell').classList.contains('is-resizing'),transition:getComputedStyle(document.querySelector('.work-surface')).transitionDuration,reloads:window.__iframeChanges})`);
    assert(duringDrag.resizing);assert.equal(duringDrag.writes,0);assert.equal(duringDrag.reloads,0);assert(duringDrag.transition.split(',').every((s: string)=>s.trim()==='0s'));
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:grip.x-35*13,y:grip.y});await delay(150);
    const wide = await win.webContents.executeJavaScript(`(()=>{const c=document.querySelector('.composer'),a=document.querySelector('.main-area').getBoundingClientRect(),r=c.getBoundingClientRect(),buttons=Array.from(c.querySelectorAll('.composer-tools button')).filter(n=>n.getBoundingClientRect().width),overflow=buttons.some(n=>{const b=n.getBoundingClientRect();return b.left<r.left||b.right>r.right+1});return {writes:window.__dragWrites,main:a.width,composer:r.width,overflow,scroll:c.scrollWidth>c.clientWidth+1,textFits:c.querySelector('textarea').scrollHeight<=c.querySelector('textarea').clientHeight+1};})()`);
    writeFileSync(join(dataRoot,'drag-observation.json'),JSON.stringify({duringDrag,wide,events:await win.webContents.executeJavaScript(`window.__dragEvents`)}));
    assert.equal(wide.writes,1);assert(wide.main>=419);assert.equal(wide.overflow,false);assert.equal(wide.scroll,false);assert(wide.textFits,'宽度变化后的短草稿应自动增高而不被截断');
    pass('真实拖动合并绘制、松手仅保存一次，不重载 HTML；窄聊天区输入框与按钮完整', {duringDrag,wide});
    await win.webContents.executeJavaScript(`window.__iframeObserver.disconnect();Storage.prototype.setItem=window.__storageSet;for(const type of ['pointerdown','pointermove','pointerup','mouseup','pointercancel','lostpointercapture'])window.removeEventListener(type,window.__dragTrace,true)`);
    await openFixture('page.html');
    await captureFrame(true);await delay(200);writeFileSync(join(dataRoot,'wide-file-preview.png'),(await captureFrame(true)).toPNG());
    await openFixture('long.ts');
    await until(async()=>{await win.webContents.executeJavaScript(`(()=>{const scroller=document.querySelector('.file-preview-scroll');scroller.scrollTop=scroller.scrollHeight;})()`);return win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll').textContent.includes('完整末尾')`);},Boolean);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.file-preview-scroll code').textContent`),previewFixtures.find(file=>file.name==='long.ts')!.text);
    pass('长文件随滚动自动续读，UTF-8 连续分页完整到达末尾，无手动分页条');
    await win.webContents.executeJavaScript(`(async()=>{const canvas=document.createElement('canvas');canvas.width=48;canvas.height=32;canvas.getContext('2d').fillRect(0,0,48,32);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));const data=new DataTransfer();data.items.add(new File([blob],'image.png',{type:'image/png'}));document.querySelector('.composer').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data}));})()`);
    await until(()=>win.webContents.executeJavaScript(`document.querySelectorAll('.attachment-chip.done').length`),n=>n===previewFixtures.length+1);
    await openFixture('image.png');
    await until(()=>win.webContents.executeJavaScript(`document.querySelector('.file-preview-image')?.naturalWidth`),n=>n===48);
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.file-preview-image').naturalHeight`),32);
    pass('图片附件使用真实图片预览，原始尺寸与比例保留');
    await win.webContents.executeJavaScript(`Array.from(document.querySelectorAll('.work-preview-tab-close')).forEach(button=>button.click())`);
    // 每次关闭会触发 React 更新，余下标签继续逐一关闭。
    for(let i=0;i<6;i++){await win.webContents.executeJavaScript(`document.querySelector('.work-preview-tab-close')?.click()`);await delay(30);}
    assert.equal(await win.webContents.executeJavaScript(`document.querySelector('.delivery-panel').innerText`),'');
    pass('关闭最后一个文件后右侧恢复完全留白');
    writeFileSync(join(dataRoot,'file-empty-preview.png'),(await captureFrame(true)).toPNG());
    writeFileSync(
      report,
      JSON.stringify(
        { name: 'Umi', passed: true, electron: process.versions.electron, evidence },
        null,
        2,
      ),
    );
  } catch (e) {
    writeFileSync(
      report,
      JSON.stringify(
        {
          name: 'Umi',
          passed: false,
          electron: process.versions.electron,
          evidence,
          error: e instanceof Error ? e.stack ?? e.message : String(e),
        },
        null,
        2,
      ),
    );
    throw e;
  }
}
