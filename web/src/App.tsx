
import { useEffect, useRef, useState } from "react";

const UNITS = [
  "cup", "tbsp", "tsp", "g", "kg", "oz",
  "lb", "ml", "l", "each", "clove", "pinch",
] as const;

type Unit = (typeof UNITS)[number];

type IngredientDraft = {
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
  result?: unknown;
  archiveKey?: string;
};

type EventState = {
  eventId: string;
  title: string;
  occurredAt: string;
  publishStatus: string;
  search: WorkerState;
  nutrition: WorkerState;
  audit: WorkerState;
};

const endpoint = (import.meta.env.VITE_API_URL || "")
  .replace(/\/$/, "");

export default function App() {
  const [token, setToken] = useState("");
  const [title, setTitle] = useState("New England Clam Chowder");

  const [ingredients, setIngredients] = useState<IngredientDraft[]>([
    { id: 1, name: "clams", quantity: "2", unit: "cup", notes: "chopped" },
    { id: 2, name: "potatoes", quantity: "2", unit: "each", notes: "diced" },
    { id: 3, name: "heavy cream", quantity: "1", unit: "cup", notes: "" },
    { id: 4, name: "onion", quantity: "1", unit: "each", notes: "diced" },
  ]);

  const nextId = useRef(5);
  const [failNutrition, setFailNutrition] = useState(false);
  const [eventId, setEventId] = useState("");
  const [state, setState] = useState<EventState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  function updateIngredient(
    id: number,
    changes: Partial<Omit<IngredientDraft, "id">>,
  ) {
    setIngredients((rows) =>
      rows.map((row) =>
        row.id === id ? { ...row, ...changes } : row
      )
    );
  }

  function addIngredient() {
    if (ingredients.length >= 30) return;

    setIngredients((rows) => [
      ...rows,
      {
        id: nextId.current++,
        name: "",
        quantity: "1",
        unit: "each",
        notes: "",
      },
    ]);
  }

  function removeIngredient(id: number) {
    setIngredients((rows) =>
      rows.filter((row) => row.id !== id)
    );
  }

  // Poll the status API until all workers finish.
  useEffect(() => {
    if (!eventId || !token || !endpoint) return;

    let cancelled = false;
    let timer: number | undefined;

    async function refresh() {
      let finished = false;

      try {
        const res = await fetch(
          `${endpoint}/recipes/${eventId}`,
          {
            headers: { "x-demo-token": token },
            cache: "no-store",
          }
        );

        if (!res.ok) {
          throw new Error(`Status API returned ${res.status}`);
        }

        const item: EventState = await res.json();

        if (cancelled) return;

        setState(item);
        setError("");

        finished =
          item.publishStatus === "FAILED" ||
          (["search", "nutrition", "audit"] as const).every(
            (key) => {
              const status = item[key]?.status;
              return status === "SUCCEEDED" || status === "FAILED";
            }
          );
      } catch (e) {
        if (!cancelled) setError(String(e));
      }

      if (!cancelled && !finished) {
        timer = window.setTimeout(() => void refresh(), 2000);
      }
    }

    void refresh();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [eventId, token]);

  async function publish() {
    setBusy(true);
    setError("");
    setState(null);
    setEventId("");

    try {
      if (!endpoint) throw new Error("API URL is not configured");
      if (!token) throw new Error("Enter the demo access token");
      if (!title.trim() || title.trim().length > 120) {
        throw new Error("Recipe title must be 1-120 characters");
      }
      if (ingredients.length < 1 || ingredients.length > 30) {
        throw new Error("Provide 1-30 ingredients");
      }

      const recipeIngredients = ingredients.map((item) => {
        const quantity = Number(item.quantity);

        if (
          !item.name.trim() ||
          item.name.length > 100 ||
          !item.quantity.trim() ||
          !Number.isFinite(quantity) ||
          quantity <= 0
        ) {
          throw new Error(`Invalid ingredient: ${item.name || "(unnamed)"}`);
        }

        return {
          name: item.name.trim(),
          quantity,
          unit: item.unit,
          ...(item.notes.trim()
            ? { notes: item.notes.trim() }
            : {}),
        };
      });

      const res = await fetch(`${endpoint}/recipes`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-demo-token": token,
        },
        body: JSON.stringify({
          title: title.trim(),
          ingredients: recipeIngredients,
          failNutrition,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || `Publish failed (${res.status})`);
      }

      setEventId(data.eventId);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const workers = [
    ["Search indexing", state?.search],
    ["Ingredient validation", state?.nutrition],
    ["Audit receipt", state?.audit],
  ] as const;

  return (
    <main>
      <header>
        <p className="eyebrow">AWS · SNS / SQS / LAMBDA</p>
        <h1>Recipe Event Lab</h1>
        <p>
          Publish an event once. Watch three independently queued
          workers process it.
        </p>
      </header>

      <section className="panel form">
        <label>
          Demo access token
          <input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Enter your token"
          />
        </label>

        <label>
          Recipe title
          <input
            value={title}
            maxLength={120}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>

        <h2>Ingredients</h2>

        {ingredients.map((item) => (
          <div className="ingredient-row" key={item.id}>
            <label>
              Ingredient name
              <input
                value={item.name}
                maxLength={100}
                onChange={(e) =>
                  updateIngredient(item.id, { name: e.target.value })
                }
              />
            </label>

            <label>
              Quantity
              <input
                type="number"
                min="0.01"
                step="any"
                value={item.quantity}
                onChange={(e) =>
                  updateIngredient(item.id, { quantity: e.target.value })
                }
              />
            </label>

            <label>
              Unit
              <select
                value={item.unit}
                onChange={(e) =>
                  updateIngredient(item.id, {
                    unit: e.target.value as Unit,
                  })
                }
              >
                {UNITS.map((unit) => (
                  <option key={unit} value={unit}>
                    {unit}
                  </option>
                ))}
              </select>
            </label>

            <label>
              Notes (optional)
              <input
                value={item.notes}
                maxLength={250}
                placeholder="e.g. chopped, sifted"
                onChange={(e) =>
                  updateIngredient(item.id, { notes: e.target.value })
                }
              />
            </label>

            <button
              type="button"
              onClick={() => removeIngredient(item.id)}
            >
              Remove
            </button>
          </div>
        ))}

        <button
          type="button"
          onClick={addIngredient}
          disabled={ingredients.length >= 30}
        >
          + Add ingredient
        </button>

        <label className="check">
          <input
            type="checkbox"
            checked={failNutrition}
            onChange={(e) => setFailNutrition(e.target.checked)}
          />
          Deliberately fail Nutrition to test retries and DLQ
        </label>

        <button
          disabled={busy || !token || !title.trim() || !endpoint}
          onClick={() => void publish()}
        >
          {busy ? "Publishing..." : "Publish recipe event"}
        </button>

        {!endpoint && (
          <p className="error">Set VITE_API_URL in web/.env.local first.</p>
        )}

        {error && <p className="error">{error}</p>}
      </section>

      {eventId && (
        <section className="panel">
          <p className="eyebrow">EVENT ID</p>
          <code>{eventId}</code>

          <p>
            Publish status:{" "}
            <strong>{state?.publishStatus ?? "checking..."}</strong>
          </p>

          <div className="worker-grid">
            {workers.map(([label, info]) => (
              <article key={label} className="worker">
                <h3>{label}</h3>
                <span className={"state " + (info?.status || "PENDING")}>
                  {info?.status || "PENDING"}
                </span>

                {info?.detail && <p>{info.detail}</p>}
                {info?.archiveKey && (
                  <p>Archive key: <code>{info.archiveKey}</code></p>
                )}
                {info?.result !== null && (
                  <pre>{JSON.stringify(info?.result, null, 2)}</pre>
                )}
              </article>
            ))}
          </div>

          <p className="footnote">
            Processing status is read from DynamoDB every two seconds
            until the workers reach terminal states.
          </p>
        </section>
      )}

      <footer>
        Portfolio prototype · Demonstration data only
      </footer>
    </main>
  );
}
