import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import '@fontsource-variable/sora';
import '@fontsource-variable/inter';
import './styles/site.css';
import './styles/landing.css';
import './styles/studio.css';

// The server opens this page itself in a headless browser to track faces and subjects for the camera; it needs no StrictMode.
const ClipWorker = lazy(() => import('./components/ClipWorker'));
const view = new URLSearchParams(window.location.search).get('view');
createRoot(document.getElementById('root')!).render(
  view === 'clip-worker' ? <Suspense fallback={null}><ClipWorker /></Suspense> : (
    <StrictMode>
      <App />
    </StrictMode>
  ),
);
