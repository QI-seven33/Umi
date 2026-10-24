type MarkdownNode={type:string;value?:string;alt?:string;title?:string;children?:MarkdownNode[]};
const cjk=/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

// 仅为渲染输入补临时分隔符，解析后删除；原始消息及复制内容不改。
// CommonMark会把紧邻中文的标点强调解析为文字，甚至把相邻两组**交叉配对。
export function prepareChatMarkdown(source:string){
 let sentinel='\uE000';while(source.includes(sentinel))sentinel+='\uE000';
 const markers=[sentinel+' ', ' '+sentinel] as const;
 let fence:{char:string;length:number}|null=null;
 const text=source.split(/(?<=\n)/).map(line=>{
  const mark=/^ {0,3}([`~]{3,})(.*)$/.exec(line.trimEnd());
  if(fence){if(mark&&mark[1]!.split('').every(c=>c===fence!.char)&&mark[1]!.length>=fence.length&&!mark[2]!.trim())fence=null;return line;}
  if(mark&&mark[1]!.split('').every(c=>c===mark[1]![0])){fence={char:mark[1]![0]!,length:mark[1]!.length};return line;}
  if(/^(?: {4}|\t| {0,3}\[[^\]]+\]:)/.test(line))return line;
  let out='',i=0;
  while(i<line.length){
   if(line[i]==='\\'){out+=line.slice(i,i+2);i+=2;continue;}
   if(line[i]==='`'){
    const run=/^`+/.exec(line.slice(i))![0];let end=line.indexOf(run,i+run.length);
    while(end>=0&&(line[end-1]==='`'||line[end+run.length]==='`'))end=line.indexOf(run,end+run.length);
    if(end<0){out+=line.slice(i);break;}
    out+=line.slice(i,end+run.length);i=end+run.length;continue;
   }
   // 链接目标/标题及HTML标签不参与强调修补。
   if(line[i-1]===']'&&line[i]==='('){
    let depth=1,end=i+1;for(;end<line.length&&depth;end++){if(line[end]==='\\')end++;else if(line[end]==='(')depth++;else if(line[end]===')')depth--;}
    out+=line.slice(i,end);i=end;continue;
   }
   if(line[i]==='<'){const end=line.indexOf('>',i+1);if(end>=0){out+=line.slice(i,end+1);i=end+1;continue;}}
   const match=line.startsWith('**',i)&&line[i-1]!=='*'?/^\*\*([^*\n]+)\*\*/.exec(line.slice(i)):null;
   if(match){
    const inner=match[1]!,after=line[i+match[0].length]??'',before=line[i-1]??'';
    if(after!=='*'&&inner.trim()===inner&&cjk.test(before+inner+after)&&/^\p{P}|\p{P}$/u.test(inner)){out+=markers[0]+match[0]+markers[1];i+=match[0].length;continue;}
   }
   out+=line[i];i++;
  }
  return out;
 }).join('');
 return {text,markers};
}
export function remarkCjkEmphasis(markers:readonly string[]=[]){
 return (tree:MarkdownNode)=>{
  const clean=(value:string)=>markers.reduce((text,marker)=>text.replaceAll(marker,''),value);
  const visit=(node:MarkdownNode)=>{
   if(node.value)node.value=clean(node.value);
   if(node.alt)node.alt=clean(node.alt);if(node.title)node.title=clean(node.title);
   for(const child of node.children??[])visit(child);
  };
  visit(tree);
 };
}
