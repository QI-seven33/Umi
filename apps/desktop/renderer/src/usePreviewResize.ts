import { useEffect, useRef } from 'react';
import type { PointerEvent, RefObject } from 'react';

/** 连续拖动只更新一处 CSS 变量；React 和持久化只在松开时提交一次。 */
export function usePreviewResize(shell: RefObject<HTMLElement | null>, surface: RefObject<HTMLDivElement | null>, commit: (width: number) => void) {
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);
  return (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault(); cleanup.current?.();
    const node = event.currentTarget, host = shell.current, area = surface.current;
    if (!host || !area) return;
    const start = event.clientX, initial = area.querySelector('.delivery-panel')!.getBoundingClientRect().width;
    const maximum = Math.max(260, Math.min(760, area.clientWidth - 420));
    let latest = initial, frame: number | null = null, done = false;
    const paint = () => { frame = null; host.style.setProperty('--right-open-width', `${latest}px`); };
    const move = (ev: globalThis.PointerEvent) => {
      latest = Math.max(260, Math.min(maximum, initial + start - ev.clientX));
      if (frame === null) frame = requestAnimationFrame(paint);
    };
    const finish = () => {
      if (done) return; done = true;
      if (frame !== null) cancelAnimationFrame(frame); paint();
      window.removeEventListener('pointermove', move, true); window.removeEventListener('pointerup', finish, true); window.removeEventListener('mouseup', finish, true); window.removeEventListener('pointercancel', finish, true); window.removeEventListener('blur', finish); node.removeEventListener('lostpointercapture', finish);
      if (node.hasPointerCapture(event.pointerId)) node.releasePointerCapture(event.pointerId);
      host.classList.remove('is-resizing'); cleanup.current = null;
      commit(latest); localStorage.setItem('umi.work.rightWidth', String(latest));
    };
    host.classList.add('is-resizing'); node.setPointerCapture(event.pointerId);
    window.addEventListener('pointermove', move, true); window.addEventListener('pointerup', finish, true); window.addEventListener('mouseup', finish, true); window.addEventListener('pointercancel', finish, true); window.addEventListener('blur', finish); node.addEventListener('lostpointercapture', finish);
    cleanup.current = finish;
  };
}
