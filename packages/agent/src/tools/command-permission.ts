import type {ExecutionContext} from '../../../protocol/src/model.js';

// 有限的任务许可候选，绝不是任意代码安全分类器。脚本内容仍可变化和访问宿主。
// 安装/发布/外发/删除、复合Shell与无法识别的命令始终回到单次批准。
export function taskCommandCandidate(name:string,context:ExecutionContext):boolean {
 const p=context.process;
 if(!p||context.execution||!['run_command','run_shell'].includes(name)||p.preparation||p.stdin||p.cwdRef.kind!=='mount')return false;
 if(p.mode!=='direct')return /^(?:npm(?:\.cmd)?[ \t]+(?:test|run[ \t]+(?:test|build|lint|typecheck|check)))$/.test(p.script??'');
 if(!/(?:^|[\\/])node(?:\.exe)?$/i.test(p.program)||p.argv[0]!=='--test')return false;
 return p.argv.length>1&&p.argv.slice(1).every(arg=>/^[\p{L}\p{N}_.\\/: -]+$/u.test(arg)&&!arg.startsWith('-'));
}
