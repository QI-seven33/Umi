import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function Dialog({ title, children, onClose, busy = false, className = '' }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null), titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current!; dialog.showModal();
    return () => { dialog.close(); if(previous?.isConnected) previous.focus(); };
  }, []);
  return createPortal(<dialog ref={ref} className={`ui-dialog ${className}`} aria-labelledby={titleId} aria-busy={busy}
    onCancel={event=>{event.preventDefault();if(!busy)onClose();}}>
    <h3 id={titleId}>{title}</h3>{children}
  </dialog>,document.body);
}
