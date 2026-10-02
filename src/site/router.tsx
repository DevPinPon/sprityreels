import { useEffect, useState } from 'react';
import type { AnchorHTMLAttributes, MouseEvent } from 'react';

/** A tiny History API router: two pages, no dependency. */
export function navigate(to: string, replace = false) {
  if (replace) history.replaceState(null, '', to); else history.pushState(null, '', to);
  window.dispatchEvent(new PopStateEvent('popstate'));
  if (!replace && !to.includes('#')) window.scrollTo({ top: 0 });
}

export function useLocation() {
  const read = () => ({ path: window.location.pathname.replace(/\/+$/, '') || '/', search: window.location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const on = () => setLoc(read());
    window.addEventListener('popstate', on);
    return () => window.removeEventListener('popstate', on);
  }, []);
  return loc;
}

export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || rest.target === '_blank') return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={click} {...rest} />;
}
