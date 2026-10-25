import { Children, isValidElement, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, ReactElement, SelectHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';

/** Styled select-only combobox. Focus stays on the trigger; no native unstyled popup. */
export function Select({ children, value, onChange, disabled, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  const options = Children.toArray(children).filter(isValidElement).map(child => (child as ReactElement<{value: string | number; children: string; disabled?: boolean}>).props);
  const id = useId(), trigger = useRef<HTMLButtonElement>(null), popup = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false), [active, setActive] = useState(0), [rect, setRect] = useState({ left: 0, top: 0, width: 0, maxHeight: 240 });
  const selected = options.findIndex(option => String(option.value) === String(value));
  const choose = (index: number) => {
    const option = options[index]; if (!option || option.disabled) return;
    onChange?.({ target: { value: String(option.value) }, currentTarget: { value: String(option.value) } } as ChangeEvent<HTMLSelectElement>);
    setOpen(false); trigger.current?.focus();
  };
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = trigger.current!.getBoundingClientRect(), height = Math.min(options.length * 36 + 12, 260), below = innerHeight - r.bottom - 12;
      const above = below < Math.min(height, 140) && r.top > below;
      const maxHeight = Math.min(height, Math.max(80, above ? r.top - 16 : below));
      setRect({ left: Math.max(8, Math.min(r.left, innerWidth - r.width - 8)), width: r.width, top: above ? r.top - maxHeight - 5 : r.bottom + 5, maxHeight });
    };
    const dismiss = (e: PointerEvent) => { if (!trigger.current?.contains(e.target as Node) && !popup.current?.contains(e.target as Node)) setOpen(false); };
    place(); window.addEventListener('resize', place); document.addEventListener('scroll', place, true); document.addEventListener('pointerdown', dismiss);
    return () => { window.removeEventListener('resize', place); document.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', dismiss); };
  }, [open, options.length]);
  useLayoutEffect(() => { if (open) popup.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' }); }, [active, open]);
  return <><button ref={trigger} type="button" className="ui-select" role="combobox" aria-label={props['aria-label']}
    aria-expanded={open} aria-controls={open ? id : undefined} aria-haspopup="listbox" aria-activedescendant={open ? `${id}-${active}` : undefined}
    disabled={disabled} data-value={value} onBlur={e => { if (!popup.current?.contains(e.relatedTarget)) setOpen(false); }}
    onClick={() => { setActive(Math.max(0, selected)); setOpen(!open); }}
    onKeyDown={e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
      else if (e.key === 'Tab') setOpen(false);
      else if (['ArrowDown','ArrowUp','Home','End'].includes(e.key)) {
        e.preventDefault(); setOpen(true);
        const start = open ? active : Math.max(0, selected), direction = e.key === 'ArrowUp' ? -1 : 1;
        let next = e.key === 'Home' ? 0 : e.key === 'End' ? options.length - 1 : open ? (start + direction + options.length) % options.length : start;
        for (let i=0; options[next]?.disabled && i<options.length; i++) next=(next+direction+options.length)%options.length;
        setActive(next);
      } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (open) choose(active); else { setActive(Math.max(0, selected)); setOpen(true); } }
      else if (e.key.length===1 && !e.ctrlKey && !e.metaKey) { const next=options.findIndex(o=>String(o.children).toLocaleLowerCase().startsWith(e.key.toLocaleLowerCase())&&!o.disabled);if(next>=0){setActive(next);setOpen(true);} }
    }}><span>{options[selected]?.children ?? String(value ?? '')}</span><ChevronDown size={14}/></button>
    {open && createPortal(<div ref={popup} id={id} className="ui-select-popup" role="listbox" aria-label={props['aria-label']} style={{ position: 'fixed', ...rect }}>
      {options.map((option,index)=><div id={`${id}-${index}`} key={option.value} role="option" aria-selected={index===selected} aria-disabled={option.disabled} data-index={index} className={index===active?'is-active':''}
        onPointerDown={e=>e.preventDefault()} onPointerMove={()=>{if(!option.disabled)setActive(index);}} onClick={()=>choose(index)}><span>{option.children}</span>{index===selected&&<Check size={14}/>}</div>)}
    </div>,document.body)}</>;
}
