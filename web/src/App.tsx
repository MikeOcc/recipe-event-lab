import { useEffect, useState } from 'react';

type WorkerState = { status: string; detail?: string; processedAt?: string; result?: unknown };
type EventState = {
  eventId: string; title: string; occurredAt: string; publishStatus: string;
  search: WorkerState; nutrition: WorkerState; audit: WorkerState;
};
const endpoint = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export default function App() {
  const [token, setToken] = useState('');
  const [title, setTitle] = useState('New England Clam Chowder');
  const [ingredients, setIngredients] = useState('clams, potatoes, cream, onion');
  const [failNutrition, setFailNutrition] = useState(false);
  const [eventId, setEventId] = useState('');
  const [state, setState] = useState<EventState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!eventId || !token || !endpoint) return;
    let cancelled = false;
    async function refresh() {
      try {
        const res = await fetch(`${endpoint}/recipes/${eventId}`, {
          headers: { 'x-demo-token': token }, cache: 'no-store',
        });
        if (!res.ok) throw new Error(`Status API returned ${res.status}`);
        const item: EventState = await res.json();
        if (!cancelled) setState(item);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [eventId, token]);

  async function publish() {
    setBusy(true); setError(''); setState(null); setEventId('');
    try {
      const res = await fetch(`${endpoint}/recipes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-demo-token': token },
        body: JSON.stringify({
          title, failNutrition,
          ingredients: ingredients.split(',').map(s => s.trim()).filter(Boolean),
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Publish failed (${res.status})`);
      setEventId(data.eventId);
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }

  const workers = [
    ['Search indexing', state?.search],
    ['Ingredient validation', state?.nutrition],
    ['Audit receipt', state?.audit],
  ] as const;

  return <main>
    <header><p className="eyebrow">AWS · SNS / SQS / LAMBDA</p><h1>Recipe Event Lab</h1>
      <p>Publish an event once. Watch three independently queued workers process it.</p></header>
    <section className="panel form">
      <label>Demo access token <input type="password" value={token} onChange={e => setToken(e.target.value)} placeholder="Enter your token"/></label>
      <label>Recipe title <input value={title} maxLength={120} onChange={e => setTitle(e.target.value)}/></label>
      <label>Ingredients (comma-separated) <textarea value={ingredients} onChange={e => setIngredients(e.target.value)}/></label>
      <label className="check"><input type="checkbox" checked={failNutrition} onChange={e => setFailNutrition(e.target.checked)}/>
        Deliberately fail ingredient validation to test retries + DLQ</label>
      <button disabled={busy || !token || !title.trim() || !endpoint} onClick={() => void publish()}>
        {busy ? 'Publishing…' : 'Publish recipe event'}</button>
      {!endpoint && <p className="error">Set VITE_API_URL in web/.env.local first.</p>}
      {error && <p className="error">{error}</p>}
    </section>
    {eventId && <section className="panel"><p className="eyebrow">EVENT ID</p><code>{eventId}</code>
      <p>Publish status: <strong>{state?.publishStatus ?? 'checking...'}</strong></p>
      <div className="worker-grid">{workers.map(([label, info]) =>
        <article key={label} className="worker"><h3>{label}</h3>
          <span className={'state ' + (info?.status || 'PENDING')}>{info?.status || 'PENDING'}</span>
          {info?.detail && <p>{info.detail}</p>}
          {info?.result && <pre>{JSON.stringify(info.result, null, 2)}</pre>}
        </article>)}</div>
      <p className="footnote">The page polls DynamoDB-backed status every two seconds. A failed worker stays RETRYING here; inspect the SQS dead-letter queue in AWS to confirm final redrive.</p>
    </section>}
    <footer>Portfolio prototype • Fictional demonstration data, not an official America's Test Kitchen product.</footer>
  </main>;
}
