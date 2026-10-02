import { useEffect, useState } from 'react';
import { Check, Copy, Download, FileText, Image as ImageIcon, Package, Plus, RotateCcw, Trash2 } from 'lucide-react';
import type { ClipJob, ClipShort } from '../../engine/clips/types';
import { clipsAPI, message } from './api';
import type { ClipShortDetail, ClipShortSummary, Overview, SourceDetail } from './api';
import { Banner, Bar, Spinner, clock, keepFor, queueText } from './ui';

const ratio = (aspect: string) => aspect.replace(':', ' / ');
const postText = (s: ClipShort) => [s.post.title, s.post.description, s.post.hashtags.map(h => `#${h}`).join(' ')].filter(Boolean).join('\n\n');

function ReelCard({ short, job, onChanged }: { short: ClipShortSummary; job?: ClipJob; onChanged: () => void }) {
  const status = short.render?.status ?? 'queued', revision = short.render?.revision ?? short.revision;
  const [info, setInfo] = useState<ClipShortDetail | null>(null);
  const [copied, setCopied] = useState(false);
  const [unplayable, setUnplayable] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (status !== 'done' && status !== 'failed') return;
    let alive = true;
    clipsAPI<ClipShortDetail>(`/shorts/${short.id}`).then(d => alive && setInfo(d)).catch(() => {});
    return () => { alive = false; };
  }, [short.id, status, revision]);

  const aspect = info?.short.aspect ?? '9:16', base = `/api/clips/shorts/${short.id}`;
  const retry = async () => { setError(''); try { await clipsAPI(`/shorts/${short.id}/render`, {}); onChanged(); } catch (e) { setError(message(e)); } };
  const remove = async () => { if (!window.confirm(`Delete “${short.name}”?`)) return; try { await clipsAPI(`/shorts/${short.id}/delete`, {}); onChanged(); } catch (e) { setError(message(e)); } };
  const copy = async () => { if (!info) return; try { await navigator.clipboard.writeText(postText(info.short)); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setError('Copy is not available here. Select the text and copy it yourself.'); } };
  const warnings = info?.render?.warnings ?? [];

  return (
    <article className={`reel glass ${status}`}>
      <div className="reel-media" style={{ aspectRatio: ratio(aspect) }}>
        {status === 'done' ? (
          <video controls playsInline preload="metadata" poster={`${base}/cover?v=${revision}`} src={`${base}/video?v=${revision}`} aria-label={`Reel: ${short.name}`} onError={() => setUnplayable(true)} />
        ) : status === 'failed' ? (
          <div className="reel-state bad"><RotateCcw /><b>This one did not finish</b></div>
        ) : (
          <div className="reel-state"><Spinner size={30} /><b>{queueText(job?.queue) || (status === 'queued' ? 'Waiting its turn…' : 'Rendering…')}</b><Bar value={short.render?.progress ?? 0} label="Render progress" /><small>{Math.round((short.render?.progress ?? 0) * 100)}%</small></div>
        )}
      </div>
      <div className="reel-body">
        <h3 title={short.name}>{short.name}</h3>
        <p className="muted">{status === 'done' ? `${clock(short.render?.duration ?? short.seconds)} · ${aspect}` : `About ${Math.round(short.seconds)} seconds`}{status === 'done' && !short.render?.current ? ' · changed since render' : ''}</p>
        {status === 'failed' && <Banner kind="error">{info?.render?.error || 'Rendering failed.'}</Banner>}
        {unplayable && <Banner kind="warn">This browser could not play the reel here. Download the MP4 to watch it.</Banner>}
        {warnings.length > 0 && <Banner kind="warn">{warnings[0]}</Banner>}
        {error && <Banner kind="error">{error}</Banner>}
        {info && status === 'done' && info.short.post.hashtags.length > 0 && <p className="tags">{info.short.post.hashtags.slice(0, 6).map(h => `#${h}`).join(' ')}</p>}
        <div className="reel-actions">
          {status === 'done' && <a className="btn sm" href={`${base}/video?download=1`} download><Download /> MP4</a>}
          {status === 'done' && <a className="btn sm ghost" href={`${base}/srt`} download><FileText /> Subtitles</a>}
          {status === 'done' && <a className="btn sm ghost" href={`${base}/cover`} download={`${short.id}.jpg`}><ImageIcon /> Cover</a>}
          {status === 'done' && info && <button type="button" className="btn sm ghost" onClick={() => void copy()}>{copied ? <><Check /> Copied</> : <><Copy /> Post text</>}</button>}
          {status === 'failed' && <button type="button" className="btn sm" onClick={() => void retry()}><RotateCcw /> Try again</button>}
          <button type="button" className="icon-btn" aria-label={`Delete ${short.name}`} onClick={() => void remove()}><Trash2 /></button>
        </div>
      </div>
    </article>
  );
}

export default function Reels({ detail, overview, onMore, onChanged }: { detail: SourceDetail; overview: Overview | null; onMore: () => void; onChanged: () => void }) {
  const { source, shorts } = detail;
  const done = shorts.filter(s => s.render?.status === 'done').length, working = shorts.some(s => s.render && (s.render.status === 'queued' || s.render.status === 'rendering'));
  return (
    <div className="reels">
      <header className="reels-head">
        <div>
          <span className="kicker">{working ? 'Rendering' : 'Done'}</span>
          <h1>{shorts.length ? (working ? 'Your reels are being made' : 'Your reels are ready') : 'No reels yet'}</h1>
          <p className="muted clip-1" title={source.title}>From “{source.title}”</p>
        </div>
        <div className="reels-actions">
          {done > 1 && <a className="btn" href={`/api/clips/sources/${source.id}/export`} download><Package /> Download all ({done})</a>}
          <button type="button" className="btn ghost" onClick={onMore}><Plus /> Make more reels</button>
        </div>
      </header>
      {done > 1 && <p className="help">The ZIP has a folder per reel (MP4, subtitles, cover and post text) and a posting sheet for bulk scheduling.</p>}
      {overview && overview.limits.retentionHours > 0 && done > 0 && <p className="help">Your reels are kept for {keepFor(overview.limits.retentionHours)} after your last visit. Download the ones you want.</p>}
      {shorts.length === 0 ? <Banner kind="info" action={<button type="button" className="btn sm" onClick={onMore}>Pick moments</button>}>Choose a few moments and we will turn them into reels.</Banner> : (
        <div className="reel-grid">{shorts.map(s => <ReelCard key={s.id} short={s} job={detail.jobs.find(j => j.shortId === s.id && j.kind === 'render' && (j.status === 'queued' || j.status === 'running'))} onChanged={onChanged} />)}</div>
      )}
    </div>
  );
}
