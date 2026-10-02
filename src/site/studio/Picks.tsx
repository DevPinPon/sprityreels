import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, Check, Clock, Play, Search, Sparkles, X, Zap } from 'lucide-react';
import { CAPTION_PRESETS } from '../../engine/clips/types';
import type { ClipAspect, ClipMoment, ClipMomentSet, ClipSource, ClipSubject } from '../../engine/clips/types';
import { CAPTION_PRESET_DEFS } from '../../engine/clips/captions';
import { captionStyle } from '../captionStyle';
import { LENGTHS, clipsAPI, message } from './api';
import type { LengthId, Overview, ReelStyle, SourceDetail } from './api';
import { Banner, ScoreRing, Segmented, Spinner, Toggle, clock } from './ui';

const SUBJECTS: { id: ClipSubject; label: string }[] = [
  { id: 'auto', label: 'Auto (recommended)' }, { id: 'speaker', label: 'Speakers only' }, { id: 'person', label: 'People' }, { id: 'ball', label: 'The ball' },
  { id: 'vehicle', label: 'Vehicles' }, { id: 'animal', label: 'Animals' }, { id: 'motion', label: 'Whatever moves' },
];
const ASPECTS: { id: ClipAspect; label: string; hint: string }[] = [
  { id: '9:16', label: '9:16', hint: 'Reels · TikTok' }, { id: '4:5', label: '4:5', hint: 'Feed' }, { id: '1:1', label: '1:1', hint: 'Square' }, { id: '16:9', label: '16:9', hint: 'Wide' },
];
const MAX_REELS = 20;
const isAi = (set: ClipMomentSet) => set.engine === 'gemini' || set.engine === 'claude' || set.engine === 'codex';
const baseName = (set: ClipMomentSet) => isAi(set) ? `AI picks${set.prompt ? ` · “${set.prompt}”` : ''}` : set.prompt ? `Picks · “${set.prompt}”` : 'Automatic picks';
/** Sets with the same name are numbered in the order they were made, so two searches never look alike. */
const setName = (set: ClipMomentSet, sets: ClipMomentSet[]) => {
  const same = sets.filter(s => baseName(s) === baseName(set)).sort((a, b) => a.created - b.created);
  return same.length > 1 ? `${baseName(set)} (${same.indexOf(set) + 1})` : baseName(set);
};

function Preview({ source, moment }: { source: ClipSource; moment: ClipMoment }) {
  const [info, setInfo] = useState<{ url: string; offset: number } | null>(null);
  const [error, setError] = useState('');
  const [unplayable, setUnplayable] = useState(false);
  useEffect(() => {
    let alive = true;
    clipsAPI<{ url: string; offset: number }>(`/sources/${source.id}/preview`, { start: moment.start, end: moment.end }).then(r => alive && setInfo(r)).catch(e => alive && setError(message(e)));
    return () => { alive = false; };
  }, [source.id, moment.start, moment.end]);
  if (error) return <Banner kind="error">{error}</Banner>;
  if (!info) return <div className="preview-wait"><Spinner /> Getting this part of the video…</div>;
  const from = moment.start - info.offset, to = moment.end - info.offset;
  if (unplayable) return <Banner kind="warn">Your browser cannot play this file’s format, so there is no preview. Your reels are still made from it and play everywhere.</Banner>;
  return (
    <video className="preview" src={info.url} onError={() => setUnplayable(true)} controls autoPlay playsInline preload="metadata" aria-label={`Preview of ${moment.title}`}
      onLoadedMetadata={e => { e.currentTarget.currentTime = Math.max(0, from); }}
      onTimeUpdate={e => { const v = e.currentTarget; if (v.currentTime >= to) { v.pause(); v.currentTime = Math.max(0, from); } }} />
  );
}

function MomentCard({ moment, rank, source, selected, onToggle, previewing, onPreview }: { moment: ClipMoment; rank: number; source: ClipSource; selected: boolean; onToggle: () => void; previewing: boolean; onPreview: () => void }) {
  const checks = moment.checks ?? [], warn = checks.find(c => c.level === 'warn'), fixed = checks.some(c => c.level === 'fixed');
  const note = warn ? { cls: 'amber', text: warn.text } : moment.kind === 'action' ? { cls: 'violet', text: 'Action moment' } : fixed ? { cls: 'blue', text: 'Edited to stand alone' } : { cls: 'mint', text: 'Stands alone' };
  const meters: [string, number][] = [['Hook', moment.scores.hook], ['Flow', moment.scores.flow], ['Value', moment.scores.value], ['Trend', moment.scores.trend]];
  return (
    <article className={`moment glass${selected ? ' selected' : ''}`}>
      <div className="moment-top">
        <button type="button" className="pick-box" role="checkbox" aria-checked={selected} aria-label={`${selected ? 'Deselect' : 'Select'} moment ${rank}: ${moment.title}`} onClick={onToggle}><Check /></button>
        <div className="moment-title"><span className="rank">#{rank}</span><h3>{moment.title}</h3></div>
        <ScoreRing value={moment.score} />
      </div>
      {moment.hook && moment.hook !== moment.title && <p className="quote">“{moment.hook}”</p>}
      {moment.reason && <p className="reason">{moment.reason}</p>}
      <div className="moment-meta">
        <span className={`chip ${note.cls}`}>{moment.kind === 'action' ? <Zap /> : <Check />}{note.text}</span>
        <span className="chip"><Clock /> {clock(moment.start)}–{clock(moment.end)} · {Math.round(moment.end - moment.start)}s</span>
      </div>
      <dl className="meters">{meters.map(([label, value]) => <div key={label}><dt>{label}</dt><dd><span className="mini"><i style={{ width: `${Math.max(4, Math.min(100, value * 10))}%` }} /></span><b>{Math.round(value * 10) / 10}</b></dd></div>)}</dl>
      <div className="moment-foot">
        <button type="button" className="btn ghost sm" onClick={onPreview} aria-expanded={previewing}>{previewing ? <><X /> Close preview</> : <><Play /> Preview</>}</button>
      </div>
      {previewing && <Preview source={source} moment={moment} />}
    </article>
  );
}

function FindMore({ source, ai, sees, running, failure, onFound }: { source: ClipSource; ai: boolean; sees: boolean; running: boolean; failure: string; onFound: () => void }) {
  const [length, setLength] = useState<LengthId>('standard');
  const [count, setCount] = useState(8);
  const [prompt, setPrompt] = useState('');
  const [useAi, setUseAi] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    const l = LENGTHS.find(x => x.id === length)!;
    setBusy(true); setError('');
    try {
      await clipsAPI(`/sources/${source.id}/moments`, { count, minSeconds: l.min, maxSeconds: l.max, prompt: prompt.trim(), ...(useAi ? { engine: sees ? 'claude' : 'gemini', userRequestedGeneration: true } : { engine: 'local' }) });
      onFound();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  };
  return (
    <details className="find glass flat">
      <summary><Search /> Look for different moments<span className="muted"> · length, topic{ai ? ', AI' : ''}</span></summary>
      <div className="find-body">
        <div className="find-row"><span className="lbl">Length</span><Segmented value={length} onChange={setLength} label="Reel length" options={LENGTHS.map(l => ({ id: l.id, label: l.label, hint: l.hint }))} /></div>
        <div className="find-row"><label className="lbl" htmlFor="find-count">How many</label>
          <select id="find-count" className="field" value={count} onChange={e => setCount(Number(e.target.value))}>{[3, 5, 8, 12, 20].map(n => <option key={n} value={n}>{n} moments</option>)}</select></div>
        <div className="find-row"><label className="lbl" htmlFor="find-prompt">What are you looking for? <span className="muted">(optional)</span></label>
          <input id="find-prompt" className="field" placeholder="the funniest moments, money advice, the big reveal…" maxLength={500} value={prompt} onChange={e => setPrompt(e.target.value)} /></div>
        {ai && <Toggle checked={useAi} onChange={setUseAi} label="Rank with AI" hint={sees ? 'An AI model reads the transcript and looks at frames of your video. A little slower.' : 'A language model reads the transcript and picks. A little slower.'} />}
        {error && <Banner kind="error">{error}</Banner>}
        {failure && <Banner kind="error">The AI could not finish: {failure}</Banner>}
        <button type="button" className="btn sm" disabled={busy || running} onClick={() => void go()}>{busy || running ? <><Spinner size={16} /> {running ? 'The AI is reading your video…' : 'Looking…'}</> : <><Sparkles /> Find moments</>}</button>
      </div>
    </details>
  );
}

function StylePanel({ style, onChange }: { style: ReelStyle; onChange: (s: ReelStyle) => void }) {
  const set = <K extends keyof ReelStyle>(key: K, value: ReelStyle[K]) => onChange({ ...style, [key]: value });
  return (
    <aside className="style glass" aria-label="Reel style">
      <h2>Make it yours</h2>
      <section>
        <Toggle checked={style.captions} onChange={v => set('captions', v)} label="Captions" hint="Animated, word by word" />
        <div className={`cap-chips${style.captions ? '' : ' off'}`} role="radiogroup" aria-label="Caption style">
          {CAPTION_PRESETS.map(id => (
            <button type="button" role="radio" aria-checked={style.preset === id} key={id} disabled={!style.captions} className={style.preset === id ? 'on' : ''} onClick={() => set('preset', id)}>
              <span style={captionStyle(id, 230).word(true)}>{CAPTION_PRESET_DEFS[id].label}</span>
            </button>
          ))}
        </div>
      </section>
      <section><span className="lbl">Format</span><Segmented value={style.aspect} onChange={v => set('aspect', v)} label="Format" options={ASPECTS} /></section>
      <section><label className="lbl" htmlFor="subject">The camera follows</label>
        <select id="subject" className="field" value={style.subject} onChange={e => set('subject', e.target.value as ClipSubject)}>{SUBJECTS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select></section>
      <section className="toggles">
        <Toggle checked={style.hook} onChange={v => set('hook', v)} label="Hook title" hint="A title card in the first seconds" />
        <Toggle checked={style.bleep} onChange={v => set('bleep', v)} label="Bleep swear words" hint="Masked in captions too" />
      </section>
    </aside>
  );
}

type Props = { detail: SourceDetail; overview: Overview | null; style: ReelStyle; onStyle: (s: ReelStyle) => void; creating: boolean; error: string; onCreate: (momentIds: string[]) => void; onFound: () => void };

export default function Picks({ detail, overview, style, onStyle, creating, error, onCreate, onFound }: Props) {
  const { source, moments: sets } = detail;
  const [index, setIndex] = useState(0);
  const set = sets[Math.min(index, Math.max(0, sets.length - 1))] as ClipMomentSet | undefined;
  const [selected, setSelected] = useState<string[]>([]);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const newest = sets[0]?.id;
  useEffect(() => { setIndex(0); }, [newest]);
  useEffect(() => { setSelected((set?.moments ?? []).slice(0, 3).map(m => m.id)); setPreviewId(null); }, [set?.id]);

  const moments = set?.moments ?? [];
  const chosen = useMemo(() => moments.filter(m => selected.includes(m.id)), [moments, selected]);
  const toggle = (id: string) => setSelected(cur => cur.includes(id) ? cur.filter(x => x !== id) : cur.length >= MAX_REELS ? cur : [...cur, id]);
  const finding = detail.jobs.find(j => j.kind === 'moments' && (j.status === 'running' || j.status === 'queued'));
  const lastFailed = detail.jobs.find(j => j.kind === 'moments' && j.status === 'failed' && Date.now() - j.updated < 120_000);
  return (
    <div className="picks">
      <div className="picks-main">
        <header className="panel-head left">
          <h1>Pick the moments to turn into reels</h1>
          <p>{moments.length ? <>We found <b>{moments.length}</b> moment{moments.length === 1 ? '' : 's'} in “{source.title}”. The best ones are selected.</> : 'No moments matched these settings.'}</p>
        </header>
        {sets.length > 1 && (
          <div className="set-tabs" role="tablist" aria-label="Sets of moments">
            {sets.map((s, i) => <button type="button" role="tab" aria-selected={i === index} className={i === index ? 'on' : ''} key={s.id} onClick={() => setIndex(i)}>{isAi(s) && <Sparkles />}{setName(s, sets)}</button>)}
          </div>
        )}
        <FindMore source={source} ai={!!(overview?.ai.gemini || overview?.ai.claude)} sees={!!overview?.ai.claude} running={!!finding} failure={lastFailed?.error ?? ''} onFound={onFound} />
        {moments.length === 0 && <Banner kind="info">Nothing matched. Try a different length, or ask for something else above.</Banner>}
        <div className="moment-list">
          {moments.map((m, i) => <MomentCard key={m.id} moment={m} rank={i + 1} source={source} selected={selected.includes(m.id)} onToggle={() => toggle(m.id)} previewing={previewId === m.id} onPreview={() => setPreviewId(previewId === m.id ? null : m.id)} />)}
        </div>
      </div>
      <div className="picks-side"><StylePanel style={style} onChange={onStyle} /></div>
      <div className="action-bar glass" role="region" aria-label="Create reels">
        <div><b>{chosen.length}</b> selected{selected.length >= MAX_REELS && <small> · most at once</small>}<small className="hide-s"> · {chosen.length ? `about ${Math.round(chosen.reduce((t, m) => t + (m.end - m.start), 0))} seconds in total` : 'pick at least one'}</small></div>
        {error && <span className="bar-error" role="alert">{error}</span>}
        <button type="button" className="btn" disabled={!chosen.length || creating} onClick={() => onCreate(chosen.map(m => m.id))}>{creating ? <><Spinner /> Creating…</> : <>Create {chosen.length || ''} reel{chosen.length === 1 ? '' : 's'} <ArrowRight /></>}</button>
      </div>
    </div>
  );
}
