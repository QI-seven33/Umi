import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
export const verificationSkillInput={repository:'https://github.com/umi-verification/skill-fixture',path:'skills/import-example',ref:'main'};
export const verificationCommit='d'.repeat(40);
export function skillSourceFixture(extraBody=''){
  const files=new Map<string,Uint8Array>([
    ['SKILL.md',Buffer.from('---\nname: import-example\ndescription: Imported verification method with an on-demand reference.\nlicense: MIT\n---\n# Imported method\nRead [reference](references/check.md) only when needed.\n'+extraBody)],
    ['references/check.md',Buffer.from('Fixture reference: VERIFICATION-ONLY-7391.\n')],
    ['scripts/no-run.mjs',Buffer.from('throw Error("must never run during import");\n')],
    ['assets/sample.bin',Buffer.from([0,255,31,128])],
  ]);
  const blob=(data:Uint8Array)=>createHash('sha1').update('blob '+data.length+'\0').update(data).digest('hex');
  const entries=[...files].map(([path,bytes])=>({path,type:'blob',mode:path.startsWith('scripts/')?'100755':'100644',sha:blob(bytes),size:bytes.length}));
  const dirs=['references','scripts','assets'].map(path=>({path,type:'tree',mode:'040000',sha:'e'.repeat(40)}));
  const requests:string[]=[];
  const transport:typeof fetch=async(input,init)=>{
    const url=new URL(String(input));requests.push(url.href);
    if(init?.redirect!=='error'||new Headers(init?.headers).has('authorization'))throw Error('unsafe request');
    const json=(data:unknown)=>new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
    if(url.host==='api.github.com'){
      if(url.pathname.includes('/git/blobs/')){
        const hash=url.pathname.split('/').at(-1);const entry=[...files].find(([,b])=>blob(b)===hash);
        if(entry&&new Headers(init?.headers).get('accept')==='application/vnd.github.raw+json')return new Response(Buffer.from(entry[1]));
      }
      if(url.pathname.endsWith('/commits/main'))return json({sha:verificationCommit,commit:{tree:{sha:'a'.repeat(40)}}});
      if(url.pathname.endsWith('/git/trees/'+'a'.repeat(40)))return json({sha:'a'.repeat(40),truncated:false,tree:[{path:'skills',type:'tree',mode:'040000',sha:'b'.repeat(40)}]});
      if(url.pathname.endsWith('/git/trees/'+'b'.repeat(40)))return json({sha:'b'.repeat(40),truncated:false,tree:[{path:'import-example',type:'tree',mode:'040000',sha:'c'.repeat(40)}]});
      if(url.pathname.endsWith('/git/trees/'+'c'.repeat(40)))return json({sha:'c'.repeat(40),truncated:false,tree:[...dirs,...entries]});
      if(url.pathname==='/repos/umi-verification/skill-fixture')return json({default_branch:'main'});
    }
    if(url.host==='raw.githubusercontent.com'){
      if(!url.pathname.includes('/'+verificationCommit+'/'))throw Error('not pinned');
      const path=url.pathname.split('/skills/import-example/')[1],bytes=path?files.get(decodeURIComponent(path)):undefined;
      if(bytes)return new Response(Buffer.from(bytes));
    }
    return new Response('not found',{status:404});
  };
  return {files,entries,dirs,requests,transport,blob};
}
// GUI回归使用确定的离线响应，稍作延迟让真实进度与队列检查有观察窗口。
export const verificationSkillFetch:typeof fetch=async(input,init)=>{
  await delay(30,undefined,init?.signal?{signal:init.signal}:{});
  return skillSourceFixture('中😀文方法\n'.repeat(1100)+'FULL-PREVIEW-END').transport(input,init);
};