import {useRef} from 'react';
import '../../styles/JellyRadio.css';
type Item={value:string;label:string};
// 保留紧凑单选芯片，文字不缩放，以免切换时产生模糊和漂移。
export function JellyRadio({items,value,onChange,disabled=false}:{items:Item[];value:string;onChange:(value:string)=>void;disabled?:boolean}){
  const buttons=useRef<(HTMLButtonElement|null)[]>([]);
  const select=(index:number)=>{
    const next=items[index];if(disabled||!next||next.value===value)return;
    onChange(next.value);
  };
  return <div className="jelly-radio" role="radiogroup" aria-label="思考强度" aria-disabled={disabled}>
    {items.map((item,i)=><button ref={el=>{buttons.current[i]=el;}} type="button" key={item.value} className="jelly-radio__chip" role="radio" aria-checked={item.value===value} tabIndex={item.value===value?0:-1} disabled={disabled} data-on={item.value===value} onClick={()=>select(i)} onKeyDown={e=>{
      const direction=['ArrowRight','ArrowDown'].includes(e.key)?1:['ArrowLeft','ArrowUp'].includes(e.key)?-1:0;
      const next=e.key==='Home'?0:e.key==='End'?items.length-1:direction?(i+direction+items.length)%items.length:null;
      if(next!==null){e.preventDefault();select(next);buttons.current[next]?.focus();}
    }}><span className="jelly-radio__skin">{item.label}</span></button>)}
  </div>;
}
