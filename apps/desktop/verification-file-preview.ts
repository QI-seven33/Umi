import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { BrowserWindow } from 'electron';
import type { AgentBroker } from './broker.js';
import { filePreviewFixtures } from './verification-preview-fixtures.js';

/** 独立数据下沿真实附件链路检查排版，不向不可信 HTML 注入脚本。 */
export async function verifyFilePreview(broker: AgentBroker, win: BrowserWindow, dataRoot: string) {
  const evidence: { name: string; passed: true; details?: unknown }[] = [];
  const read = (code: string) => win.webContents.executeJavaScript(code);
  const until = async (code: string) => {
    for (let i = 0; i < 200; i++) { if (await read(code)) return; await delay(50); }
    throw Error('预览条件未满足: ' + code);
  };
  const save = (passed: boolean, error?: unknown) => writeFileSync(join(dataRoot, 'desktop-verification.json'), JSON.stringify({ passed, evidence, ...(error ? { error: String(error) } : {}) }, null, 2));
  const pass = (name: string, details?: unknown) => { evidence.push({ name, passed: true, details }); writeFileSync(join(dataRoot, 'preview-progress.json'), JSON.stringify({checks:evidence.length,last:name})); };
  const screenshot = async (name: string) => writeFileSync(join(dataRoot, name + '.png'), (await win.webContents.capturePage(undefined, { stayAwake: true })).toPNG());
  const open = async (name: string) => {
    await read('Array.from(document.querySelectorAll(".attachment-name")).find(n=>n.textContent===' + JSON.stringify(name) + ').click()');
    await until('document.querySelector(".file-preview-path")?.textContent.endsWith(' + JSON.stringify(name) + ')&&document.querySelector(".file-preview-scroll")?.getAttribute("aria-busy")==="false"');
  };
  const mode = async (value: 'source' | 'preview') => {
    await read('document.querySelector(".file-options-menu summary").click();document.querySelector(".file-view-options button:' + (value === 'source' ? 'first-child' : 'last-child') + '").click()');
    await until('document.querySelector(".file-preview-scroll")?.dataset.mode===' + JSON.stringify(value));
  };
  // DOMSnapshot 可能跨渲染进程；跟随当前窗口的子目标观察实际排版和文本框。
  const htmlSnapshot = async (name: string) => {
    await until('!!document.querySelector(".file-html-preview")');
    await delay(350);
    await screenshot(name);
    win.webContents.debugger.attach('1.3');
    try {
      let snapshot = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      if (!snapshot.documents.some((d: any) => snapshot.strings[d.documentURL] === 'about:srcdoc')) {
        const { targetInfo } = await win.webContents.debugger.sendCommand('Target.getTargetInfo');
        const { targetInfos } = await win.webContents.debugger.sendCommand('Target.getTargets');
        const targets = targetInfos.filter((t: any) => t.type === 'iframe' && t.url === 'about:srcdoc' && t.parentId === targetInfo.targetId);
        assert.equal(targets.length, 1, '当前窗口应只有一个 HTML 预览子页面');
        const { sessionId } = await win.webContents.debugger.sendCommand('Target.attachToTarget', { targetId: targets[0].targetId, flatten: true });
        snapshot = await win.webContents.debugger.sendCommand('DOMSnapshot.captureSnapshot', { computedStyles: [] }, sessionId);
      }
      writeFileSync(join(dataRoot, name + '.json'), JSON.stringify(snapshot));
      const strings: string[] = snapshot.strings, doc = snapshot.documents.find((d: any) => strings[d.documentURL] === 'about:srcdoc');
      assert(doc && doc.layout.nodeIndex.length > 3 && doc.textBoxes.layoutIndex.length > 0, 'HTML 应有真实可见排版和文字框');
      const text = doc.nodes.nodeValue.map((i: number) => strings[i]).join('');
      assert(!doc.nodes.nodeName.some((i: number) => strings[i] === 'SCRIPT'));
      assert(!text.includes('__previewExecuted'));
      assert.equal(await read('document.querySelector(".file-html-preview").getAttribute("sandbox")'), '');
      return { text, layoutNodes: doc.layout.nodeIndex.length, textBoxes: doc.textBoxes.layoutIndex.length };
    } finally { win.webContents.debugger.detach(); }
  };
  try {
    await broker.ready(); win.showInactive(); win.webContents.setBackgroundThrottling(false);
    const workspace = join(dataRoot, 'preview-workspace'); mkdirSync(workspace, { recursive: true });
    const conversation = await broker.request({ internal: 'create_internal', payload: { workspace } }) as { conversationId: string };
    if (win.webContents.isLoading()) await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
    await read('localStorage.setItem("umi.work.activeThread",' + JSON.stringify(conversation.conversationId) + ');localStorage.setItem("umi.theme","light");location.reload()');
    await new Promise<void>(resolve => win.webContents.once('did-finish-load', () => resolve()));
    await until('document.querySelector(".composer textarea")?.disabled===false'); await delay(200);
    await read('document.documentElement.dataset.material="solid"');
    const longHtml = '<!doctype html><html><head><style>/*' + '跨分页的样式注释'.repeat(7000) + '*/body{font:16px system-ui;padding:24px;color:#16395b;background:#f4f8fc}</style></head><body><h1>长 HTML 预览</h1>' + '<p>连续分页正文</p>'.repeat(300) + '<p>完整 HTML 末尾</p></body></html>';
    const longMd = '# 长 Markdown\n\n' + '一段连续的中文正文。\n\n'.repeat(3200) + '## 完整 Markdown 末尾\n';
    const fixtures = [...filePreviewFixtures(), { name: 'long.html', text: longHtml }, { name: 'long.md', text: longMd }];
    await read('(()=>{const data=new DataTransfer();for(const f of ' + JSON.stringify(fixtures) + ')data.items.add(new File([f.text],f.name,{type:"text/plain"}));document.querySelector(".composer").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:data}));})()');
    await until('document.querySelectorAll(".attachment-chip.done").length===' + fixtures.length);
    await read('window.__previewFrames=[];window.__previewSeen=new WeakSet();window.__previewObserver=new MutationObserver(records=>{for(const r of records){if(r.type==="attributes")window.__previewFrames.push({kind:"replace",name:r.target.title});for(const n of r.addedNodes)if(n instanceof Element)for(const f of [n,...n.querySelectorAll("iframe")])if(f instanceof HTMLIFrameElement&&!window.__previewSeen.has(f)){window.__previewSeen.add(f);window.__previewFrames.push({kind:"mount",name:f.title,source:f.srcdoc});}}});window.__previewObserver.observe(document.querySelector(".delivery-panel"),{subtree:true,childList:true,attributes:true,attributeFilter:["srcdoc"]})');
    for (let i = 0; i < 24; i++) {
      const name = i % 2 ? 'fixed.html' : 'page.html'; await open(name);
      if (i % 6 === 1) { win.setSize(i % 4 ? 1120 : 1440, 960); await delay(180); }
      if (i % 6 === 2) { await mode('source'); await mode('preview'); }
      if (i % 6 === 3) { await read('document.querySelector(".file-preview-reload").click()'); await until('document.querySelector(".file-preview-scroll")?.getAttribute("aria-busy")==="false"'); }
      if (i % 6 === 4) { await read('document.querySelector(".right-rail-toggle").click()'); await delay(180); await read('document.querySelector(".right-rail-toggle").click()'); }
      if (i % 6 === 5) { win.hide(); await delay(100); win.showInactive(); }
      const result = await htmlSnapshot('html-' + i);
      assert(result.text.includes(i % 2 ? '完整宽度预览' : 'HTML 静态文件预览'));
      pass('HTML 切换、原文往返、重载、窄宽度、侧栏及窗口恢复 ' + (i + 1), { layoutNodes: result.layoutNodes, textBoxes: result.textBoxes });
    }
    await read('window.__previewFrames=[]'); await open('long.html');
    const long = await htmlSnapshot('long-html'); assert(long.text.includes('完整 HTML 末尾'));
    const frames = await read('window.__previewFrames');
    assert.equal(frames.length, 1, '完整 HTML 应仅创建一次子页面，不逐段重载'); assert.equal(frames[0].kind, 'mount');
    await mode('source'); assert.equal(await read('document.querySelector(".file-code code").textContent'), longHtml);
    pass('长 HTML 跨8KiB/64KiB连续读取、仅挂载一次、完整原文和末尾均保留', { bytes: Buffer.byteLength(longHtml), layoutNodes: long.layoutNodes });
    for (const name of ['guide.md', 'app.ts', 'ledger.jsonl', 'long.ts', 'long.md']) {
      await open(name); const fixture = fixtures.find(f => f.name === name)!;
      if (name.startsWith('long.')) await until('(()=>{const s=document.querySelector(".file-preview-scroll");s.scrollTop=s.scrollHeight;return s.textContent.includes(' + JSON.stringify(name.endsWith('.md') ? '完整 Markdown 末尾' : '完整末尾') + ');})()');
      if (name.endsWith('.md')) assert(await read('!!document.querySelector(".file-markdown h1")'));
      else assert(await read('document.querySelectorAll(".file-code [class^=hljs-]").length>0'));
      assert(await read('(()=>{const s=document.querySelector(".file-preview-scroll");return s.scrollWidth<=s.clientWidth+1;})()'));
      await screenshot(name.replace('.', '-'));
      await mode('source'); assert.equal(await read('document.querySelector(".file-code code").textContent'), fixture.text);
      pass(name + ' 真实排版或着色、长行折行和完整原文');
    }
    await read('window.__previewObserver.disconnect()');
    // 清除输入区的验收附件名额，不删除持久化文件，再走真实 PNG 上传入口。
    await read('document.querySelectorAll(".attachment-chip").forEach(n=>n.querySelector("button[aria-label]")?.click())');
    await until('document.querySelectorAll(".attachment-chip").length===0');
    await read('(async()=>{const canvas=document.createElement("canvas");canvas.width=48;canvas.height=32;canvas.getContext("2d").fillRect(0,0,48,32);const blob=await new Promise(resolve=>canvas.toBlob(resolve,"image/png"));const data=new DataTransfer();data.items.add(new File([blob],"image.png",{type:"image/png"}));data.items.add(new File([""],"empty.html",{type:"text/plain"}));data.items.add(new File(["<h1>HTML 片段</h1><p>无需完整文档标签</p>"],"fragment.html",{type:"text/plain"}));data.items.add(new File(["普通文本 <img src=x onerror=alert(1)>"],"notes.txt",{type:"text/plain"}));document.querySelector(".composer").dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:data}));})()');
    await until('document.querySelectorAll(".attachment-chip.done").length===4');
    await open('empty.html');
    assert(await read('!document.querySelector(".file-html-preview,.file-preview-loading,.file-preview-error")'));
    await mode('source'); assert.equal(await read('document.querySelector(".file-code code").textContent'), '');
    pass('空 HTML 正常留白，读取结束，无永久加载提示');
    await open('fragment.html'); const fragment = await htmlSnapshot('html-fragment');
    assert(fragment.text.includes('HTML 片段')); pass('HTML 片段按完整静态文档排版');
    await open('notes.txt');
    assert.equal(await read('document.querySelector(".file-code code").textContent'), '普通文本 <img src=x onerror=alert(1)>');
    assert(await read('!document.querySelector(".file-preview-scroll img")')); pass('普通文本保留原字符，不执行其中的标签');
    await open('image.png');
    await until('document.querySelector(".file-preview-image")?.naturalWidth===48');
    assert.equal(await read('document.querySelector(".file-preview-image").naturalHeight'), 32);
    await screenshot('image-preview'); pass('PNG 实际解码和原始比例');
    save(true);
  } catch (error) { await screenshot('failure').catch(() => undefined); save(false, error); throw error; }
}
