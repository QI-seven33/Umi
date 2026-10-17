/** 只供隔离的真实桌面验收使用；通过附件入口进入正式预览链路。 */
export function filePreviewFixtures() {
  return [
    { name: 'guide.md', text: [
      '# 文件预览', '', '一处安静、清晰的阅读空间。', '', '## 格式与内容', '',
      '- **Markdown** 保留标题、列表和引用', '- 代码按语言着色', '', '> 只呈现文件本身。', '',
      '```ts', 'const message: string = "hello";', '```', '',
      '| 文件 | 预览 |', '| --- | --- |', '| guide.md | 排版正文 |', '| app.ts | 语法着色 |',
    ].join('\n') },
    { name: 'app.ts', text: [
      '// Umi · 文件预览', 'export interface PreviewOptions {', '  mode: "source" | "preview";', '  path: string;', '}', '',
      'export function greeting(name: string): string {', '  const message = `hello, ${name}`;', '  return message;', '}', '',
      'const escaped = "<img src=x onerror=alert(1)>";', 'const longPath = "' + 'some/very-long-path/'.repeat(25) + '";',
    ].join('\n') },
    { name: 'page.html', text: [
      '<!doctype html><html><head><style>',
      'body{font:16px system-ui;margin:0;padding:24px;background:#f4f8fc;color:#16395b}h1{font-weight:500}p{line-height:1.8}',
      '</style></head><body><h1>hello</h1><p>HTML 静态文件预览</p>',
      '<script>window.__previewExecuted=true;parent.__previewExecuted=true</script>',
      '<a href="https://example.invalid">外部链接</a></body></html>',
    ].join('') },
    { name: 'fixed.html', text: '<!doctype html><html><head><style>body{width:1280px;margin:0;padding:24px;font:16px system-ui;background:#f4f8fc;color:#16395b}h1{font-weight:500}</style></head><body><h1>完整宽度预览</h1><p>固定宽度页面按侧栏宽度适应显示。</p></body></html>' },
    { name: 'ledger.jsonl', text: '{"at":"2026-10-15","status":"ready","count":42}\n{"status":"done"}' },
    { name: 'long.ts', text: Array.from({ length: 1800 }, (_, i) => '// 第 ' + i + ' 行 · 中文连续读取').join('\n') + '\nconst finalMarker = "完整末尾";' },
  ];
}
