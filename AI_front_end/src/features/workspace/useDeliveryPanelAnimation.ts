import { useCallback, useLayoutEffect, useRef } from "react";
import { gsap } from "gsap";

// ─────────────────────────────────────────────────────────────
// 交付面板动画
// ─────────────────────────────────────────────────────────────

export function useDeliveryPanelAnimation(open: boolean, mounted: boolean) {
  const panelRef = useRef<HTMLElement | null>(null);
  const openTlRef = useRef<gsap.core.Timeline | null>(null);

  const playOpen = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    openTlRef.current?.kill();
    const layers = Array.from(panel.querySelectorAll<HTMLElement>(".delivery-layers span"));
    const items = Array.from(panel.querySelectorAll<HTMLElement>(".work-panel-body > *"));
    const controls = panel.querySelector<HTMLElement>(".work-panel-controls");
    const closeIcon = panel.querySelector<SVGElement>(".work-panel-controls .sidebar-toggle:last-child svg");
    gsap.set(layers, { xPercent: 105, opacity: 1 });
    gsap.set(items, { yPercent: 130, rotate: 8, opacity: 0 });
    gsap.set(controls, { opacity: 0, y: -8 });
    if (closeIcon) gsap.set(closeIcon, { rotate: 0, transformOrigin: "50% 50%" });
    const tl = gsap.timeline({
      onComplete: () => {
        gsap.set(items, { clearProps: "transform" });
        gsap.set(controls, { clearProps: "transform" });
        openTlRef.current = null;
      },
    });
    if (layers.length) {
      tl.to(layers, { xPercent: 0, duration: 0.5, ease: "power4.out", stagger: 0.07 }, 0);
      tl.to(layers, { opacity: 0, duration: 0.25, ease: "power2.out" }, 0.45);
    }
    if (closeIcon) tl.to(closeIcon, { rotate: 180, duration: 0.8, ease: "power4.out" }, 0.15);
    if (controls) tl.to(controls, { opacity: 1, y: 0, duration: 0.4, ease: "power2.out" }, 0.15);
    if (items.length) tl.to(items, {
      yPercent: 0, rotate: 0, opacity: 1, duration: 0.65, ease: "power4.out",
      stagger: { each: 0.08, from: "start" },
    }, 0.22);
    openTlRef.current = tl;
  }, []);

  const playClose = useCallback(() => {
    const panel = panelRef.current;
    if (!panel) return;
    openTlRef.current?.kill();
    openTlRef.current = null;
    const layers = Array.from(panel.querySelectorAll<HTMLElement>(".delivery-layers span"));
    const items = Array.from(panel.querySelectorAll<HTMLElement>(".work-panel-body > *"));
    const controls = panel.querySelector<HTMLElement>(".work-panel-controls");
    const closeIcon = panel.querySelector<SVGElement>(".work-panel-controls .sidebar-toggle:last-child svg");
    if (layers.length) gsap.to(layers, { xPercent: 105, duration: 0.3, ease: "power3.in", stagger: 0.03 });
    if (items.length) gsap.to(items, { yPercent: 35, rotate: 4, opacity: 0, duration: 0.22, ease: "power2.in", stagger: 0.03 });
    if (controls) gsap.to(controls, { opacity: 0, y: -6, duration: 0.2, ease: "power2.in" });
    if (closeIcon) gsap.to(closeIcon, { rotate: 0, duration: 0.3, ease: "power2.inOut" });
  }, []);

  useLayoutEffect(() => { if (mounted) { if (open) playOpen(); else playClose(); } },
    [mounted, open, playOpen, playClose]);
  useLayoutEffect(() => () => { openTlRef.current?.kill(); }, []);
  return panelRef;
}
