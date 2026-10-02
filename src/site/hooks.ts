import { useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

/** Fades sections in as they scroll into view. Content stays visible without script (the hidden state needs .js-reveal). */
export function useReveal() {
  useEffect(() => {
    const root = document.documentElement;
    if (!('IntersectionObserver' in window)) return;
    root.classList.add('js-reveal');
    const io = new IntersectionObserver(entries => { for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }, { rootMargin: '0px 0px -6% 0px', threshold: .08 });
    const scan = () => document.querySelectorAll('[data-reveal]:not(.in)').forEach(el => io.observe(el));
    scan();
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });
    return () => { io.disconnect(); mo.disconnect(); root.classList.remove('js-reveal'); };
  }, []);
}

/** A soft light that follows the pointer across a card (sets --mx and --my). */
export const spotlight = {
  onPointerMove(event: PointerEvent<HTMLElement>) {
    const el = event.currentTarget, box = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${event.clientX - box.left}px`);
    el.style.setProperty('--my', `${event.clientY - box.top}px`);
  },
};

/** Tilts an element towards the pointer while it is over `area` (sets --rx and --ry). Off for touch and reduced motion. */
export function useTilt<T extends HTMLElement>(max = 7) {
  const area = useRef<HTMLDivElement>(null), target = useRef<T>(null);
  useEffect(() => {
    const host = area.current, el = target.current;
    if (!host || !el || matchMedia('(prefers-reduced-motion: reduce), (pointer: coarse)').matches) return;
    const move = (event: globalThis.PointerEvent) => {
      const box = host.getBoundingClientRect(), x = (event.clientX - box.left) / box.width - .5, y = (event.clientY - box.top) / box.height - .5;
      el.style.setProperty('--ry', `${-9 + x * max * 2}deg`); el.style.setProperty('--rx', `${3 - y * max * 2}deg`);
    };
    const leave = () => { el.style.removeProperty('--ry'); el.style.removeProperty('--rx'); };
    host.addEventListener('pointermove', move); host.addEventListener('pointerleave', leave);
    return () => { host.removeEventListener('pointermove', move); host.removeEventListener('pointerleave', leave); };
  }, [max]);
  return { area, target };
}
