import { Link } from './router';

export function Logo({ to = '/' }: { to?: string }) {
  return (
    <Link to={to} className="logo" aria-label="Sprity Reels home">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="lg" x1="8" y1="4" x2="56" y2="60" gradientUnits="userSpaceOnUse"><stop stopColor="#8b5cf6" /><stop offset=".55" stopColor="#6366f1" /><stop offset="1" stopColor="#22d3ee" /></linearGradient>
          <linearGradient id="ls" x1="0" y1="0" x2="0" y2="1"><stop stopColor="#fff" stopOpacity=".55" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        </defs>
        <rect width="64" height="64" rx="18" fill="url(#lg)" />
        <rect x="2" y="2" width="60" height="30" rx="16" fill="url(#ls)" />
        <path d="M26 20.5v23a2 2 0 0 0 3 1.7l19-11.5a2 2 0 0 0 0-3.4l-19-11.5a2 2 0 0 0-3 1.7z" fill="#fff" />
      </svg>
      <span>Sprity <b>Reels</b></span>
    </Link>
  );
}

/** The drifting colour behind every page. */
export function Backdrop() {
  return <><div className="aurora" aria-hidden="true"><i /><i /><i /></div><div className="grain" aria-hidden="true" /></>;
}
