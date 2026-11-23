import { useEffect, useRef, useState } from "react";

type Unit =
  | "cup" | "tbsp" | "tsp" | "g" | "kg" | "oz"
  | "lb" | "ml" | "l" | "each" | "clove" | "pinch";

type Ingredient = {
  id: number;
  name: string;
  quantity: string;
  unit: Unit;
  notes: string;
};

type WorkerState = {
  status: string;
  detail?: string;
  processedAt?: string;
  archiveKey?: string;
  result?: unknown;
};

type EventState = {
  eventId: string;
  title: string;
  publishStatus: string;
  occurredAt: string;
  search?: WorkerState;
  nutrition?: WorkerState;
  audit?: WorkerState;
};

type WorkerKey = "search" | "nutrition" | "audit";

const UNIT_OPTIONS: { value: Unit; label: string }[] = [
  { value: "cup", label: "cups" },
  { value: "tbsp", label: "tbsp" },
  { value: "tsp", label: "tsp" },
  { value: "g", label: "grams" },
  { value: "kg", label: "kg" },
  { value: "oz", label: "oz" },
  { value: "lb", label: "lb" },
  { value: "ml", label: "mL" },
  { value: "l", label: "liters" },
  { value: "each", label: "each" },
  { value: "clove", label: "cloves" },
  { value: "pinch", label: "pinches" },
];

const WORKERS: { key: WorkerKey; number: string; label: string; description: string }[] = [
  { key: "search", number: "01", label: "Search indexing", description: "Ingredient keywords" },
  { key: "nutrition", number: "02", label: "Ingredient validation", description: "Recipe checks" },
  { key: "audit", number: "03", label: "Audit receipt", description: "Event trace" },
];

const endpoint = (import.meta.env.VITE_API_URL || "").replace(/\/+$/, "");

const STARTER: Ingredient[] = [
  { id: 1, name: "Clams", quantity: "2", unit: "cup", notes: "Chopped" },
  { id: 2, name: "Potatoes", quantity: "2", unit: "each", notes: "Diced" },
  { id: 3, name: "Heavy cream", quantity: "1", unit: "cup", notes: "" },
  { id: 4, name: "Onion", quantity: "1", unit: "each", notes: "Diced" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function workerStatus(value: string | undefined): string {
  return value === "SUCCEEDED" || value === "FAILED" || value === "RETRYING"
    || value === "PENDING" ? value : "PENDING";
}

function workerSummary(key: WorkerKey, result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (key === "search" && Array.isArray(result.keywords)) {
    return `${result.keywords.length} search keywords extracted`;
  }
  if (key === "nutrition" && typeof result.ingredientCount === "number") {
    return `${result.ingredientCount} ingredients validated`;
  }
  if (key === "audit" && typeof result.version === "number") {
    return `Event schema v${result.version} recorded`;
  }
  return "Processing completed";
}

function isComplete(item: EventState): boolean {
  if (item.publishStatus === "FAILED") return true;
  return (WORKERS.every(({ key }) => {
    const status = item[key]?.status;
    return status === "SUCCEEDED" || status === "FAILED";
  }));
}

export default function App() {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("New England Clam Chowder");
  const [ingredients, setIngredients] = useState<Ingredient[]>(STARTER);
  const nextId = useRef(5);
  const [failNutrition, setFailNutrition] = useState(false);
  const [eventId, setEventId] = useState("");
  const [eventState, setEventState] = useState<EventState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function editIngredient(id: number, patch: Partial<Omit<Ingredient, "id">>) {
    setIngredients((current) => current.map((ingredient) =>
      ingredient.id === id ? { ...ingredient, ...patch } : ingredient
    ));
  }

  function addIngredient() {
    setIngredients((current) => current.length >= 30 ? current : [
      ...current,
      { id: nextId.current++, name: "", quantity: "1", unit: "each", notes: "" },
    ]);
  }

  function removeIngredient(id: number) {
    setIngredients((current) => current.filter((ingredient) => ingredient.id !== id));
  }

  // Only the status endpoint is polled. Workers run independently in AWS.
  useEffect(() => {
    if (!eventId || !token || !endpoint) return;
    let disposed = false;
    let timer: number | undefined;

    async function refresh() {
      let complete = false;
      try {
        const res = await fetch(`${endpoint}/recipes/${encodeURIComponent(eventId)}`, {
          headers: { "x-demo-token": token },
          cache: "no-store",
        });
        if (!res.ok) throw new Error(`Status request failed (HTTP ${res.status})`);
        const item: EventState = await res.json();
        if (disposed) return;
        setEventState(item);
        setError("");
        complete = isComplete(item);
      } catch (err) {
        if (!disposed) setError(String(err));
      }
      if (!disposed && !complete) timer = window.setTimeout(() => void refresh(), 2000);
    }

    void refresh();
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [eventId, token]);

  async function publish() {
    setBusy(true);
    setError("");
    setEventId("");
    setEventState(null);
    try {
      if (!endpoint) throw new Error("Set VITE_API_URL in web/.env.local first.");
      if (!token.trim()) throw new Error("Enter the demo access token.");
      const recipeTitle = title.trim();
      if (!recipeTitle || recipeTitle.length > 120) {
        throw new Error("Recipe title must be between 1 and 120 characters.");
      }
      if (!ingredients.length || ingredients.length > 30) {
        throw new Error("Provide between 1 and 30 ingredients.");
      }

      const payload = ingredients.map((ingredient, index) => {
        const name = ingredient.name.trim();
        const quantity = Number(ingredient.quantity);
        if (!name || name.length > 100 || !ingredient.quantity.trim()
          || !Number.isFinite(quantity) || quantity <= 0) {
          throw new Error(`Check ingredient ${index + 1}: a name and positive quantity are required.`);
        }
        return {
          name,
          quantity,
          unit: ingredient.unit,
          ...(ingredient.notes.trim() ? { notes: ingredient.notes.trim() } : {}),
        };
      });

      const res = await fetch(`${endpoint}/recipes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-token": token,
        },
        body: JSON.stringify({ title: recipeTitle, ingredients: payload, failNutrition }),
      });
      const data: unknown = await res.json();
      if (!res.ok) {
        const message = isRecord(data) && typeof data.error === "string"
          ? data.error : `Publish failed (HTTP ${res.status})`;
        throw new Error(message);
      }
      if (!isRecord(data) || typeof data.eventId !== "string") {
        throw new Error("Publisher did not return an event ID.");
      }
      setEventId(data.eventId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const finished = eventState ? isComplete(eventState) : false;
  const succeeded = eventState
    ? WORKERS.filter(({ key }) => eventState[key]?.status === "SUCCEEDED").length : 0;
  const failed = eventState
    ? WORKERS.some(({ key }) => eventState[key]?.status === "FAILED") : false;

  return (
    <div className="app-shell">
      <div className="topbar">
        <div className="brand"><span className="brand-mark">R<span>·</span>L</span><span>RECIPE EVENT LAB</span></div>
        <div className="topbar-meta"><span className="topbar-dot"/> AWS SERVERLESS <span className="topbar-separator">/</span> SCHEMA V2</div>
      </div>

      <main className="page-content">
        <div className="intro">
          <div>
            <p className="overline">EVENT-DRIVEN RECIPE PROCESSING</p>
            <h1>Good ingredients.<br/><em>Better infrastructure.</em></h1>
            <p className="intro-copy">Publish a recipe once, then watch three independent AWS workers process it. Built to make the invisible parts of an event-driven system visible.</p>
          </div>
          <div className="intro-stamp" aria-hidden="true"><span>01</span><span>BUILD<br/>TEST<br/>OBSERVE</span></div>
        </div>

        <div className="workspace">
          <section className="surface recipe-surface" aria-labelledby="recipe-heading">
            <div className="section-head">
              <div><p className="overline">01 / COMPOSE</p><h2 id="recipe-heading">Your recipe</h2></div>
              <span className="section-aside">v2 JSON payload</span>
            </div>

            <div className="connection-strip">
              <div className="field-group token-field">
                <label htmlFor="demo-token">Demo API token</label>
                <input id="demo-token" type="password" autoComplete="off" spellCheck={false}
                  value={token} onChange={(e) => setToken(e.target.value)} placeholder="Paste your demo access token"/>
              </div>
              <span className="connection-note"><span className="lock-icon" aria-hidden="true">◈</span> For local testing only. Not saved to your browser.</span>
            </div>

            <div className="field-group title-field">
              <label htmlFor="recipe-title">Recipe name</label>
              <input id="recipe-title" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="What are we making?" />
            </div>

            <div className="ingredients-heading">
              <div><h3>Ingredients</h3><p>Amounts, measurements and optional preparation notes.</p></div>
              <span className="ingredient-counter">{ingredients.length} / 30</span>
            </div>

            <div className="ingredient-list">
              <div className="ingredient-columns" aria-hidden="true"><span>Ingredient</span><span>Qty</span><span>Measure</span><span>Notes</span><span/></div>
              {ingredients.map((ingredient, index) => (
                <div className="ingredient-row" key={ingredient.id}>
                  <div className="ingredient-index">{String(index + 1).padStart(2, "0")}</div>
                  <input aria-label={`Ingredient ${index + 1} name`} placeholder="Ingredient" maxLength={100}
                    value={ingredient.name} onChange={(e) => editIngredient(ingredient.id, { name: e.target.value })}/>
                  <input aria-label={`Ingredient ${index + 1} quantity`} type="number" min="0.01" step="any"
                    value={ingredient.quantity} onChange={(e) => editIngredient(ingredient.id, { quantity: e.target.value })}/>
                  <select aria-label={`Ingredient ${index + 1} unit`} value={ingredient.unit}
                    onChange={(e) => editIngredient(ingredient.id, { unit: e.target.value as Unit })}>
                    {UNIT_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  <input aria-label={`Ingredient ${index + 1} notes`} placeholder="Optional" maxLength={250}
                    value={ingredient.notes} onChange={(e) => editIngredient(ingredient.id, { notes: e.target.value })}/>
                  <button type="button" className="remove-btn" aria-label={`Remove ingredient ${index + 1}`}
                    title="Remove ingredient" onClick={() => removeIngredient(ingredient.id)}>×</button>
                </div>
              ))}
            </div>

            <button type="button" className="add-btn" onClick={addIngredient} disabled={ingredients.length >= 30}>
              <span aria-hidden="true">+</span> Add ingredient
            </button>

            <div className="submit-area">
              <label className="toggle-row">
                <input type="checkbox" checked={failNutrition} onChange={(e) => setFailNutrition(e.target.checked)}/>
                <span><strong>Simulate a Nutrition failure</strong><small>Exercise SQS retries, the dead-letter queue and the failure recorder.</small></span>
              </label>
              <button type="button" className="publish-btn" disabled={busy || !token.trim() || !title.trim() || !endpoint} onClick={() => void publish()}>
                <span>{busy ? "Publishing…" : "Publish recipe"}</span><span aria-hidden="true">↗</span>
              </button>
              {!endpoint && <p className="message message-error" role="alert">Missing VITE_API_URL. Set it in web/.env.local.</p>}
              {error && <p className="message message-error" role="alert">{error}</p>}
            </div>
          </section>

          <aside className="surface status-surface" aria-labelledby="status-heading">
            <div className="section-head">
              <div><p className="overline">02 / OBSERVE</p><h2 id="status-heading">Pipeline status</h2></div>
              <span className="section-aside">SNS → SQS → Lambda</span>
            </div>

            <div className="pipeline-overview">
              <div className="pipeline-label">CURRENT EVENT</div>
              {eventId ? (
                <>
                  <code className="event-id">{eventId}</code>
                  <div className="pipeline-progress" aria-label={`${succeeded} of 3 workers succeeded`}>
                    {WORKERS.map(({ key }) => <span key={key} className={eventState?.[key]?.status === "SUCCEEDED" ? "complete" : eventState?.[key]?.status === "FAILED" ? "failed" : ""}/>) }
                  </div>
                  <div className="pipeline-meta">
                    <strong>{failed ? "Completed with failure" : finished ? "Processing complete" : "Processing event"}</strong>
                    <span>{succeeded} of 3 succeeded</span>
                  </div>
                </>
              ) : (
                <div className="empty-intro"><span className="empty-symbol" aria-hidden="true">◇</span><strong>No event yet</strong><p>Publish your recipe to see what happens at each processing stage.</p></div>
              )}
            </div>

            <div className="worker-list" aria-live="polite">
              {WORKERS.map(({ key, number, label, description }) => {
                const info = eventState?.[key];
                const status = workerStatus(info?.status);
                const result = info?.result;
                const summary = workerSummary(key, result);
                const keywordData = isRecord(result) && Array.isArray(result.keywords)
                  ? result.keywords.filter((word): word is string => typeof word === "string") : [];
                return (
                  <div className="worker-card" key={key}>
                    <div className="worker-header">
                      <div className="worker-number">{number}</div>
                      <div className="worker-name"><strong>{label}</strong><small>{description}</small></div>
                      <span className={`status-pill status-${status.toLowerCase()}`}>{status}</span>
                    </div>
                    {summary && <p className="worker-summary">{summary}</p>}
                    {info?.detail && <p className="worker-detail">{info.detail}</p>}
                    {key === "search" && keywordData.length > 0 && (
                      <div className="keyword-list">{keywordData.slice(0, 12).map((word, i) => <span key={`${word}-${i}`}>{word}</span>)}</div>
                    )}
                    {info?.archiveKey && <p className="archive-note">Archive key <code>{info.archiveKey}</code></p>}
                    {result != null && <details className="raw-details"><summary>View raw worker result</summary><pre>{JSON.stringify(result, null, 2)}</pre></details>}
                  </div>
                );
              })}
            </div>
            <p className="status-footer">Status is polled every 2 seconds while processing. Results are stored in DynamoDB.</p>
          </aside>
        </div>

        <footer className="page-footer"><span>RECIPE EVENT LAB</span><span>Portfolio demonstration · Not an official America’s Test Kitchen product</span></footer>
      </main>
    </div>
  );
}
