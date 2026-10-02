import { Check, Loader2, TriangleAlert, Info, CircleCheck } from 'lucide-react';
import type { CSSProperties, ReactNode } from 'react';

const pad = (n: number) => String(n).padStart(2, '0');
/** m:ss, or h:mm:ss from an hour. */
export const clock = (t: number) => {
  const s = Math.max(0, Math.round(t)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};
export const bytes = (n: number) => n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

export const Spinner = ({ size = 20 }: { size?: number }) => <Loader2 className="spin" style={{ width: size, height: size }} aria-hidden="true" />;

/** A 0-99 score as a ring. */
export function ScoreRing({ value, size = 58 }: { value: number; size?: number }) {
  const tone = value >= 75 ? 'hi' : value >= 50 ? 'mid' : 'lo';
  return <span className={`ring-score ${tone}`} style={{ '--v': Math.max(0, Math.min(99, value)), '--s': `${size}px` } as CSSProperties} role="img" aria-label={`Score ${value} out of 99`}><b>{value}</b></span>;
}

export function Bar({ value, label }: { value: number; label?: string }) {
  return <div className="bar-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)} aria-label={label}><i style={{ width: `${Math.max(2, Math.round(value * 100))}%` }} /></div>;
}

export function Banner({ kind = 'info', children, action }: { kind?: 'info' | 'warn' | 'error' | 'ok'; children: ReactNode; action?: ReactNode }) {
  const Icon = kind === 'warn' || kind === 'error' ? TriangleAlert : kind === 'ok' ? CircleCheck : Info;
  return <div className={`banner ${kind}`} role={kind === 'error' ? 'alert' : 'status'}><Icon aria-hidden="true" /><div>{children}</div>{action}</div>;
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; label: string; hint?: string }[]; onChange: (id: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(o => <button type="button" role="radio" aria-checked={value === o.id} key={o.id} className={value === o.id ? 'on' : ''} onClick={() => onChange(o.id)}><span>{o.label}</span>{o.hint && <small>{o.hint}</small>}</button>)}
    </div>
  );
}

/** "72 hours", "3 days". */
export const keepFor = (hours: number) => hours < 48 ? `${hours} hour${hours === 1 ? '' : 's'}` : `${Math.round(hours / 24)} days`;
/** "90 minutes", "6 hours". */
export const upTo = (minutes: number) => minutes >= 120 && minutes % 60 === 0 ? `${minutes / 60} hours` : `${minutes} minutes`;

/** Where a job waits when every worker is busy (the machine is shared by many visitors). */
export const queueText = (queue: { lane: string; ahead: number } | null | undefined) => queue ? (queue.ahead === 0 ? 'Waiting for a free worker. You are next…' : `Waiting for a free worker. ${queue.ahead} ahead of you…`) : '';

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (on: boolean) => void; label: string; hint?: string }) {
  return (
    <label className="toggle">
      <span><b>{label}</b>{hint && <small>{hint}</small>}</span>
      <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
      <i aria-hidden="true"><Check /></i>
    </label>
  );
}

export type Step = 'add' | 'analyze' | 'pick' | 'reels';
const STEPS: { id: Step; label: string }[] = [{ id: 'add', label: 'Add video' }, { id: 'analyze', label: 'Find moments' }, { id: 'pick', label: 'Pick moments' }, { id: 'reels', label: 'Get reels' }];
export function Stepper({ step, reachable, go }: { step: Step; reachable: Record<Step, boolean>; go: (step: Step) => void }) {
  const at = STEPS.findIndex(s => s.id === step);
  return (
    <ol className="stepper glass flat" aria-label="Progress">
      {STEPS.map((s, i) => (
        <li key={s.id} className={i < at ? 'done' : i === at ? 'now' : ''}>
          <button type="button" disabled={!reachable[s.id] || i === at} onClick={() => go(s.id)} aria-current={i === at ? 'step' : undefined}>
            <span className="dot">{i < at ? <Check /> : i + 1}</span><span className="lbl">{s.label}</span>
          </button>
        </li>
      ))}
    </ol>
  );
}
