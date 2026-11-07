import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import { invoke, onPush } from './lib/api';
import { store } from './lib/store';
import { CommandBar } from './views/CommandBar';
import { Dashboard } from './views/Dashboard';

function useBridge() {
  useEffect(() => {
    const offs = [
      onPush('run:event', (e) => store.applyRunEvent(e)),
      onPush('voice:event', (e) => store.applyVoiceEvent(e)),
      onPush('app:status', (s) => store.applyStatus(s)),
    ];
    // runs already in progress when this window opened
    void invoke('runs.list', {})
      .then(async ({ runs }) => {
        for (const r of runs.filter((x) => ['created', 'routing', 'planning', 'running'].includes(x.state)).slice(0, 3)) {
          store.loadSnapshot(await invoke('run.get', { runId: r.runId }));
        }
      })
      .catch(() => {});
    return () => {
      for (const off of offs) off();
    };
  }, []);
}

function App() {
  useBridge();
  const view = window.location.hash.replace(/^#\/?/, '');
  if (view === 'bar') {
    document.body.classList.add('bar-body');
    return <CommandBar />;
  }
  return <Dashboard />;
}

createRoot(document.getElementById('root') as HTMLElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
