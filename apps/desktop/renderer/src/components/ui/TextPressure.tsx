import { useEffect, useRef } from 'react';

// React Bits Text Pressure 的本地适配：固定字槽避免抖动，逐帧仅更新字体轴。
// 来源与许可见 public/third-party；可变字体离线加载，不请求远程字体。
export function TextPressure({ text = 'hello' }: { text?: string }) {
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const node = title.current!;
    const chars = Array.from(node.querySelectorAll<HTMLElement>('[data-letter]'));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, pointer: { x: number; y: number } | null = null;
    let centers: { x: number; y: number }[] = [], radius = 1;
    const values = chars.map(() => ({ weight: 300, width: 95, slant: 0 }));
    const measure = () => {
      const bounds = node.getBoundingClientRect(); radius = Math.max(60, bounds.width * .44);
      centers = chars.map(char => { const r = char.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; });
    };
    const paint = () => {
      frame = 0; let moving = false;
      chars.forEach((char, i) => {
        const center = centers[i]!;
        const pressure = pointer && !reduce.matches ? Math.max(0, 1 - Math.hypot(pointer.x - center.x, (pointer.y - center.y) * .65) / radius) : 0;
        const target = pointer ? { weight: 110 + pressure * 790, width: 65 + pressure * 86, slant: -pressure * 8 } : { weight: 300, width: 95, slant: 0 };
        const value = values[i]!;
        for (const key of ['weight', 'width', 'slant'] as const) {
          const delta = target[key] - value[key]; value[key] += delta * .18; moving ||= Math.abs(delta) > .15;
        }
        char.style.fontVariationSettings = `'opsz' 100, 'wght' ${value.weight.toFixed(1)}, 'wdth' ${value.width.toFixed(1)}, 'slnt' ${value.slant.toFixed(1)}`;
      });
      if (moving && !document.hidden && !reduce.matches) frame = requestAnimationFrame(paint);
    };
    const start = () => { if (!frame && !document.hidden) frame = requestAnimationFrame(paint); };
    const move = (event: PointerEvent) => { if (reduce.matches) return; measure(); pointer = { x: event.clientX, y: event.clientY }; start(); };
    const leave = () => { pointer = null; start(); };
    const visibility = () => { cancelAnimationFrame(frame); frame = 0; if (!document.hidden) leave(); };
    const changed = () => { pointer = null; if (reduce.matches) { cancelAnimationFrame(frame); frame = 0; for (const value of values) Object.assign(value, { weight: 300, width: 95, slant: 0 }); for (const char of chars) char.style.fontVariationSettings = "'opsz' 100, 'wght' 300, 'wdth' 95, 'slnt' 0"; } else start(); };
    measure(); const observer = new ResizeObserver(measure); observer.observe(node);
    node.addEventListener('pointermove', move); node.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', visibility); reduce.addEventListener('change', changed);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); node.removeEventListener('pointermove', move); node.removeEventListener('pointerleave', leave); document.removeEventListener('visibilitychange', visibility); reduce.removeEventListener('change', changed); };
  }, [text]);
  return <h1 ref={title} className="text-pressure" aria-label={text}>{Array.from(text).map((letter, i) => <span key={i} data-letter aria-hidden="true">{letter}</span>)}</h1>;
}
