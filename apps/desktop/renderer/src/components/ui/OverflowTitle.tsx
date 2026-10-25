import { useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
export function OverflowTitle({ text }: { text: string }) {
  const outer=useRef<HTMLSpanElement>(null),inner=useRef<HTMLSpanElement>(null),[distance,setDistance]=useState(0);
  useLayoutEffect(()=>{const measure=()=>setDistance(Math.max(0,inner.current!.scrollWidth-outer.current!.clientWidth));const observer=new ResizeObserver(measure);observer.observe(outer.current!);observer.observe(inner.current!);measure();return()=>observer.disconnect();},[text]);
  return <span ref={outer} className={`overflow-title${distance>0?' overflows':''}`} title={text} style={{'--title-travel':`-${distance}px`,'--title-duration':`${Math.max(2,distance/35)}s`} as CSSProperties}><span ref={inner}>{text}</span></span>;
}
