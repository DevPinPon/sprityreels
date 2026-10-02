import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus } from 'lucide-react';
import { Link, navigate, useLocation } from '../router';
import { Backdrop, Logo } from '../ui';
import AddVideo from './AddVideo';
import Analyzing from './Analyzing';
import Picks from './Picks';
import Reels from './Reels';
import { DEFAULT_STYLE, clipsAPI, message, styleOptions } from './api';
import type { Overview, ReelStyle, SourceDetail } from './api';
import { Banner, Stepper } from './ui';
import type { Step } from './ui';

const busy = (d: SourceDetail) => d.source.status === 'working' || d.shorts.some(s => s.render && (s.render.status === 'queued' || s.render.status === 'rendering')) || d.jobs.some(j => j.kind === 'moments' && (j.status === 'running' || j.status === 'queued'));

/** The source being worked on. Many visitors share one server, so the screen asks as rarely as it can: every 1.5 s while
 * something is running, every 20 s when nothing is (it only changes when this visitor does something, which reloads it at
 * once), every 30 s in a background tab, and straight away when the tab comes back. */
function useSourceDetail(id: string | null) {
  const [detail, setDetail] = useState<SourceDetail | null>(null);
  const [error, setError] = useState('');
  const loadRef = useRef<() => Promise<SourceDetail | undefined>>(async () => undefined);
  useEffect(() => {
    setDetail(null); setError('');
    if (!id) return;
    let stopped = false, timer = 0;
    const load = async () => {
      try { const d = await clipsAPI<SourceDetail>(`/sources/${id}`); if (!stopped) { setDetail(d); setError(''); } return d; }
      catch (e) { if (!stopped) setError(message(e)); return undefined; }
    };
    // Every load, wherever it comes from (the timer, an action of the visitor, the tab coming back), decides when the next one is.
    const refresh = async () => {
      window.clearTimeout(timer);
      const d = await load();
      if (!stopped) timer = window.setTimeout(() => void refresh(), document.hidden ? 30_000 : d && busy(d) ? 1500 : 20_000);
      return d;
    };
    loadRef.current = refresh;
    const visible = () => { if (!document.hidden && !stopped) void refresh(); };
    document.addEventListener('visibilitychange', visible);
    void refresh();
    return () => { stopped = true; window.clearTimeout(timer); document.removeEventListener('visibilitychange', visible); };
  }, [id]);
  return { detail, error, reload: useCallback(() => loadRef.current(), []) };
}

export default function Studio() {
  const { search } = useLocation();
  const params = new URLSearchParams(search), sourceId = params.get('source'), initialLink = params.get('link') ?? '';
  const [overview, setOverview] = useState<Overview | null>(null);
  const [offline, setOffline] = useState('');
  const [step, setStep] = useState<Step | null>(null);
  const [style, setStyle] = useState<ReelStyle>(DEFAULT_STYLE);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState('');
  const { detail, error: detailError, reload } = useSourceDetail(sourceId);

  const loadOverview = useCallback(async () => {
    try { setOverview(await clipsAPI<Overview>('')); setOffline(''); } catch (e) { setOffline(message(e)); }
  }, []);
  useEffect(() => { void loadOverview(); }, [loadOverview]);
  useEffect(() => { document.title = 'Studio · Sprity Reels'; }, []);

  useEffect(() => { setStep(null); setCreateError(''); }, [sourceId]);
  const status = detail?.source.status, ready = !!detail && detail.source.id === sourceId;
  useEffect(() => {
    if (!sourceId) { setStep('add'); return; }
    if (!ready || !detail) return;
    setStep(cur => {
      if (cur === null) return status === 'ready' ? (detail.shorts.length ? 'reels' : 'pick') : 'analyze';
      if (cur === 'analyze' && status === 'ready') return 'pick';
      return cur;
    });
  }, [sourceId, ready, status]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { window.scrollTo({ top: 0 }); }, [step]);

  const go = (target: Step) => { if (target === 'add') navigate('/app'); else setStep(target); };
  const act = async (route: string, body: unknown = {}) => { try { await clipsAPI(route, body); } catch (e) { setCreateError(message(e)); } await reload(); };
  const create = async (momentIds: string[]) => {
    if (!sourceId) return;
    setCreating(true); setCreateError('');
    try {
      await clipsAPI('/shorts/batch', { sourceId, momentIds, options: styleOptions(style) });
      await reload(); void loadOverview(); setStep('reels');
    } catch (e) { setCreateError(message(e)); } finally { setCreating(false); }
  };

  const reachable: Record<Step, boolean> = { add: true, analyze: ready, pick: ready && (status === 'ready' || (detail?.moments.length ?? 0) > 0), reels: ready && (detail?.shorts.length ?? 0) > 0 };
  const current: Step = step ?? (sourceId ? 'analyze' : 'add');
  return (
    <>
      <Backdrop />
      <header className="topbar">
        <div className="topbar-in glass">
          <Logo /><span className="crumb">Studio</span><span className="spacer" />
          <Link to="/" className="btn sm ghost hide-s">Home</Link>
          <button type="button" className="btn sm" onClick={() => navigate('/app')}><Plus /> New video</button>
        </div>
      </header>
      <main className="studio wrap">
        <Stepper step={current} reachable={reachable} go={go} />
        {offline && <Banner kind="error" action={<button type="button" className="btn sm ghost" onClick={() => void loadOverview()}>Try again</button>}>The studio cannot reach the server right now. {offline}</Banner>}
        {sourceId && detailError && !detail && <Banner kind="error" action={<button type="button" className="btn sm ghost" onClick={() => navigate('/app')}>Back</button>}>{detailError}</Banner>}
        {current === 'add' && <AddVideo key={sourceId ?? 'new'} overview={overview} initialLink={initialLink} onStarted={id => { void loadOverview(); navigate(`/app?source=${id}`); }} onOpen={id => navigate(`/app?source=${id}`)} onChanged={() => void loadOverview()} />}
        {current === 'analyze' && sourceId && <Analyzing detail={ready ? detail : null} onSeePicks={() => setStep('pick')} onRetry={() => void act(`/sources/${sourceId}/retry`)} onCancel={id => void act(`/jobs/${id}/cancel`)} onNew={() => navigate('/app')} />}
        {current === 'pick' && ready && detail && <Picks detail={detail} overview={overview} style={style} onStyle={setStyle} creating={creating} error={createError} onCreate={ids => void create(ids)} onFound={() => void reload()} />}
        {current === 'reels' && ready && detail && <Reels detail={detail} overview={overview} onMore={() => setStep('pick')} onChanged={() => { void reload(); void loadOverview(); }} />}
      </main>
    </>
  );
}
