// 长输入只转换载体，不总结或截断用户原话。
export const LONG_INPUT_CHARACTERS=6000;
export const LONG_INPUT_LINES=120;
export function asTextDocument(text:string){
  return text.length>=LONG_INPUT_CHARACTERS||text.split('\n').length>=LONG_INPUT_LINES;
}
export function documentInstruction(name:string){return `请阅读附件“${name}”中的完整用户消息，并按其中的要求处理。不要只根据文件名推断内容。`;}
