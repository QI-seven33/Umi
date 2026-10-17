/** 显示格式只由文件名决定；不改变文件内容、来源或交付身份。 */
const languages: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', json: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json', md: 'markdown', markdown: 'markdown', mdx: 'markdown', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', css: 'css', scss: 'scss',
  rs: 'rust', go: 'go', ps1: 'powershell', sh: 'bash', bash: 'bash', yml: 'yaml', yaml: 'yaml', sql: 'sql',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', toml: 'ini', ini: 'ini', diff: 'diff', patch: 'diff',
};
const icons: Record<string, string> = {
  ts: 'typescript', tsx: 'reactts', js: 'js', mjs: 'js', cjs: 'js', jsx: 'reactjs', py: 'python', json: 'json', jsonc: 'json', jsonl: 'json', ndjson: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown', html: 'html', htm: 'html', css: 'css', scss: 'scss', rs: 'rust',
  go: 'go', ps1: 'powershell', sh: 'shell', bash: 'shell', yaml: 'yaml', yml: 'yaml', xml: 'xml', svg: 'svg', sql: 'sql',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', pdf: 'pdf',
  csv: 'excel', xls: 'excel', xlsx: 'excel', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', java: 'java',
};
export function fileFormat(path: string) {
  const name = path.split(/[\\/]/).at(-1) ?? path, extension = name.split('.').at(-1)?.toLowerCase() ?? '';
  return { name, extension, language: languages[extension], icon: name.endsWith('.d.ts') ? 'typescriptdef' : icons[extension] ?? 'text',
    kind: /^(md|markdown|mdx)$/.test(extension) ? 'markdown' : /^(html|htm)$/.test(extension) ? 'html' : languages[extension] ? 'code' : 'text' };
}
