import { Suspense, lazy } from 'react';
import Landing from './site/Landing';
import { useLocation } from './site/router';

const Studio = lazy(() => import('./site/studio/Studio'));

export default function App() {
  const { path } = useLocation();
  if (path === '/app') return <Suspense fallback={null}><Studio /></Suspense>;
  return <Landing />;
}
