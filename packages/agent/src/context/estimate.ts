// 文本继续按 UTF-8 保守上界；图片按 DeepSeek 文档每张最多 1024 token，
// base64 是传输编码，不能按文本 token 计入预算。
export function estimateInput(body:unknown):number{
  let imageTokens=0;
  const visit=(value:unknown,key=''):unknown=>{
    if(typeof value==='string'&&(key==='dataUrl'||key==='url')&&/^data:image\/(png|jpeg|gif|webp);base64,/.test(value)){imageTokens+=1024;return '[图片]';}
    if(Array.isArray(value))return value.map(v=>visit(v));
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));
    return value;
  };
  return Buffer.byteLength(JSON.stringify(visit(body)),'utf8')+imageTokens;
}
