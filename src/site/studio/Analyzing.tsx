import { ArrowRight, AudioLines, Captions, Check, Eye, Film, Mic, Minus, RotateCcw, TriangleAlert, X } from 'lucide-react';
import type { ClipStageId, ClipSource } from '../../engine/clips/types';
import type { SourceDetail } from './api';
import { Banner, Spinner, queueText } from './ui';

const STAGES: { id: Exclude<ClipStageId, 'video'>; label: string; icon: typeof Film; linksOnly?: boolean }[] = [
  { id: 'probe', label: 'Reading your video', icon: Film },
  { id: 'captions', label: 'Checking the site’s captions', icon: Captions, linksOnly: true },
  { id: 'audio', label: 'Getting the audio', icon: AudioLines, linksOnly: true },
  { id: 'transcript', label: 'Listening to every word', icon: Mic },
  { id: 'visual', label: 'Watching the picture', icon: Eye },
];

function Ring({ value }: { value: number }) {
  const r = 84, c = 2 * Math.PI * r, pct = Math.round(value * 100);
  return (
    <svg className="big-ring" viewBox="0 0 200 200" role="img" aria-label={`${pct} percent done`}>
      <defs><linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c4b5fd" /><stop offset=".5" stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" /></linearGradient></defs>
      <circle className="track" cx="100" cy="100" r={r} />
      <circle className="orbit" cx="100" cy="100" r="95" />
      <circle className="meter" cx="100" cy="100" r={r} stroke="url(#ring-grad)" strokeDasharray={c} strokeDashoffset={c * (1 - value)} transform="rotate(-90 100 100)" />
      <text x="100" y="112" textAnchor="middle" className="pct">{pct}%</text>
    </svg>
  );
}

function StageIcon({ status }: { status: string }) {
  if (status === 'done') return <span className="st done"><Check /></span>;
  if (status === 'running') return <span className="st run"><Spinner size={16} /></span>;
  if (status === 'failed') return <span className="st bad"><TriangleAlert /></span>;
  if (status === 'skipped') return <span className="st skip"><Minus /></span>;
  return <span className="st wait" />;
}

type Props = { detail: SourceDetail | null; onSeePicks: () => void; onRetry: () => void; onCancel: (jobId: string) => void; onNew: () => void };

export default function Analyzing({ detail, onSeePicks, onRetry, onCancel, onNew }: Props) {
  if (!detail) return <section className="panel glass center-panel"><Spinner size={30} /><p className="muted">Opening your video…</p></section>;
  const source: ClipSource = detail.source, failed = source.status === 'failed';
  const job = detail.jobs.find(j => j.kind === 'import' && (j.status === 'running' || j.status === 'queued'));
  const doneStages = STAGES.filter(s => !s.linksOnly || source.kind === 'link').map(s => source.stages[s.id]?.status);
  const value = failed ? 0 : job ? job.progress : doneStages.length ? doneStages.filter(s => s === 'done' || s === 'skipped').length / doneStages.length : 1;
  const early = (detail.moments[0]?.moments.length ?? 0) > 0 && !failed;
  return (
    <section className="analyze panel glass" aria-live="polite">
      <div className="analyze-main">
        <Ring value={value} />
        <div className="analyze-text">
          <span className="kicker">{failed ? 'Something went wrong' : 'Analysing'}</span>
          <h1>{failed ? 'We could not finish this video' : 'Finding your best moments'}</h1>
          <p className="muted clip-1" title={source.title}>{source.title}</p>
          {!failed && <p className="now">{queueText(job?.queue) || job?.message || 'Getting started…'}</p>}
        </div>
      </div>

      {failed && <Banner kind="error" action={<button type="button" className="btn sm ghost" onClick={onRetry}><RotateCcw /> Try again</button>}>{source.error || 'The video could not be analysed.'}</Banner>}
      {early && <Banner kind="ok" action={<button type="button" className="btn sm" onClick={onSeePicks}>See first picks <ArrowRight /></button>}>The first picks are ready. They get sharper as the rest of the analysis finishes.</Banner>}

      <ul className="stages">
        {STAGES.filter(s => !s.linksOnly || source.kind === 'link').map(s => {
          const st = source.stages[s.id], status = st?.status ?? 'pending';
          return (
            <li key={s.id} className={status}>
              <StageIcon status={status} /><s.icon className="stage-ic" aria-hidden="true" />
              <div><b>{s.label}</b><small>{st?.message || (status === 'pending' ? 'Waiting' : '')}</small></div>
            </li>
          );
        })}
      </ul>

      <div className="analyze-actions">
        {job && <button type="button" className="btn ghost sm" onClick={() => onCancel(job.id)}><X /> Cancel</button>}
        {failed && <button type="button" className="btn ghost sm" onClick={onNew}>Start with another video</button>}
      </div>
    </section>
  );
}
