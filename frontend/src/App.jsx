import { useEffect, useRef, useState } from "react";

const sessionId = "sess-" + Math.random().toString(36).slice(2);

// Legal domains — purely visual; this choice does not change the agent's behaviour.
const DOMAINS = [
  { id: "housing", label: "Landlord–tenant / housing", icon: "🏠" },
  { id: "consumer", label: "Consumer rights / contract", icon: "🧾" },
  { id: "property", label: "Property", icon: "🏢" },
  { id: "family", label: "Family", icon: "👨‍👩‍👧" },
  { id: "immigration", label: "Immigration", icon: "🛂" },
  { id: "business", label: "Small business", icon: "💼" },
];

const ACCEPT = ".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx";

function formatSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

export default function App() {
  const [phase, setPhase] = useState("tone"); // "tone" | "domain" | "chat" | "upload" | "done"
  const [tones, setTones] = useState([]);
  const [tone, setTone] = useState(null);
  const [domain, setDomain] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const [pending, setPending] = useState([]); // files queued in the upload window
  const [uploadResult, setUploadResult] = useState(null);
  const [dossier, setDossier] = useState(null);
  const [loadingDossier, setLoadingDossier] = useState(false);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  // Load the available tones for the selection screen.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/tones");
        const data = await res.json();
        setTones(data.tones || []);
      } catch {
        setTones([]);
      }
    })();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const autosize = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
  };

  // Step 1: tone chosen → go to the domain step.
  function chooseTone(toneId) {
    setTone(toneId);
    setPhase("domain");
  }

  // Step 2: domain chosen (visual only) → start the conversation.
  async function chooseDomain(d) {
    if (busy) return;
    setDomain(d);
    setPhase("chat");
    setBusy(true);
    try {
      const res = await fetch("/api/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, tone }),
      });
      const data = await res.json();
      setMessages([{ role: "agent", text: data.reply }]);
    } catch {
      setMessages([{ role: "agent", text: "I couldn't connect. Is the server running?" }]);
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setStarted(true);
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    requestAnimationFrame(autosize);
    setBusy(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "agent", text: data.reply }]);
      // When the agent has finished its questions, move straight to the upload
      // screen (after a short beat so the wrap-up message is seen).
      if (data.done) setTimeout(() => setPhase("upload"), 1400);
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Something went wrong. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  // Inline attach (during the chat).
  async function uploadInline(files) {
    if (!files.length || busy) return;
    setStarted(true);
    const names = [...files].map((f) => f.name).join(", ");
    setMessages((m) => [...m, { role: "user", text: `📎 ${names}`, file: true }]);
    setBusy(true);
    const form = new FormData();
    form.append("session_id", sessionId);
    for (const f of files) form.append("files", f);
    try {
      const res = await fetch("/api/upload", { method: "POST", body: form });
      const data = await res.json();
      setMessages((m) => [...m, { role: "agent", text: data.reply }]);
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Upload failed. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  // Final upload window: queue + submit.
  function addPending(files) {
    const list = [...files];
    setPending((p) => [...p, ...list]);
  }
  function removePending(i) {
    setPending((p) => p.filter((_, idx) => idx !== i));
  }
  async function submitDocuments() {
    setBusy(true);
    try {
      let data = { stored: [] };
      if (pending.length) {
        const form = new FormData();
        form.append("session_id", sessionId);
        for (const f of pending) form.append("files", f);
        // Just store the files on disk — processing happens later.
        const res = await fetch("/api/documents", { method: "POST", body: form });
        data = await res.json();
      }
      setUploadResult(data);
      setPhase("done");
    } catch {
      setUploadResult({ error: true });
      setPhase("done");
    } finally {
      setBusy(false);
    }
  }

  // Extract the structured case file (synthesis + timeline) and show it.
  async function showDossier() {
    setLoadingDossier(true);
    try {
      const res = await fetch("/api/dossier", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await res.json();
      setDossier(data);
      setPhase("dossier");
    } catch {
      setDossier({ error: true });
      setPhase("dossier");
    } finally {
      setLoadingDossier(false);
    }
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (phase === "tone") {
    return <ToneScreen tones={tones} onChoose={chooseTone} disabled={busy} />;
  }
  if (phase === "domain") {
    return <DomainScreen onChoose={chooseDomain} disabled={busy} />;
  }
  if (phase === "upload") {
    return (
      <UploadScreen
        pending={pending}
        onAdd={addPending}
        onRemove={removePending}
        onSubmit={submitDocuments}
        onBack={() => setPhase("chat")}
        busy={busy}
        messages={messages}
      />
    );
  }
  if (phase === "done") {
    return (
      <DoneScreen
        result={uploadResult}
        onShowDossier={showDossier}
        loading={loadingDossier}
      />
    );
  }
  if (phase === "dossier") {
    return <DossierScreen data={dossier} onBack={() => setPhase("done")} />;
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          CLEARFILE
        </div>
        <button className="finish-btn" onClick={() => setPhase("upload")}>
          Finish & upload →
        </button>
      </header>

      <main className="conversation" ref={scrollRef}>
        <div className="thread">
          {messages.map((m, i) => (
            <Message key={i} role={m.role} text={m.text} file={m.file} />
          ))}
          {busy && <Typing />}
        </div>
      </main>

      <footer className="composer-wrap">
        <div className="composer">
          <button
            className="attach"
            title="Attach documents"
            disabled={busy}
            onClick={() => fileRef.current?.click()}
          >
            <PaperclipIcon />
          </button>
          <textarea
            ref={taRef}
            value={input}
            placeholder={started ? "Reply…" : "Describe your legal issue…"}
            rows={1}
            onChange={(e) => {
              setInput(e.target.value);
              autosize();
            }}
            onKeyDown={onKeyDown}
          />
          <button className="send" onClick={send} disabled={busy || !input.trim()}>
            <ArrowUpIcon />
          </button>
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              uploadInline(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <p className="disclaimer">
          CLEARFILE gathers information for a lawyer. It does not provide legal advice.
        </p>
      </footer>
    </div>
  );
}

function ToneScreen({ tones, onChoose, disabled }) {
  return (
    <div className="tone-screen">
      <div className="tone-inner">
        <span className="brand center">
          <span className="dot" />
          CLEARFILE
        </span>
        <div className="step-hint">Step 1 of 2</div>
        <h1 className="tone-title">How would you like me to talk with you?</h1>
        <p className="tone-sub">
          Choose a tone of voice for the assistant that will ask you questions.
        </p>
        <div className="tone-grid">
          {tones.map((t) => (
            <button
              key={t.id}
              className="tone-card"
              disabled={disabled}
              onClick={() => onChoose(t.id)}
            >
              <span className="tone-label">{t.label}</span>
              <span className="tone-desc">{t.description}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function DomainScreen({ onChoose, disabled }) {
  return (
    <div className="tone-screen">
      <div className="tone-inner">
        <span className="brand center">
          <span className="dot" />
          CLEARFILE
        </span>
        <div className="step-hint">Step 2 of 2</div>
        <h1 className="tone-title">What area of law does this relate to?</h1>
        <p className="tone-sub">Pick the area that best fits your situation.</p>
        <div className="tone-grid domain-grid">
          {DOMAINS.map((d) => (
            <button
              key={d.id}
              className="tone-card domain-card"
              disabled={disabled}
              onClick={() => onChoose(d)}
            >
              <span className="domain-icon">{d.icon}</span>
              <span className="tone-label">{d.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildRecap(messages = []) {
  const qa = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user" && !m.file) {
      const prev = messages[i - 1];
      qa.push({ q: prev && prev.role === "agent" ? prev.text : null, a: m.text });
    }
  }
  return qa;
}

function UploadScreen({ pending, onAdd, onRemove, onSubmit, onBack, busy, messages }) {
  const [drag, setDrag] = useState(false);
  const inputRef = useRef(null);
  const recap = buildRecap(messages);

  return (
    <div className="tone-screen">
      <div className="tone-inner upload-inner">
        <span className="brand center">
          <span className="dot" />
          CLEARFILE
        </span>
        <h1 className="tone-title">Add your documents</h1>
        <p className="tone-sub">
          Upload anything that supports your case — tenancy agreements, letters,
          court forms, photos, statements. A lawyer will review everything.
        </p>

        {recap.length > 0 && (
          <details className="recap" open>
            <summary className="recap-title">Summary of your answers</summary>
            <ul className="recap-list">
              {recap.map((p, i) => (
                <li key={i} className="recap-item">
                  {p.q && <div className="recap-q">{p.q}</div>}
                  <div className="recap-a">{p.a}</div>
                </li>
              ))}
            </ul>
          </details>
        )}

        <div
          className={"dropzone" + (drag ? " drag" : "")}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            if (e.dataTransfer.files?.length) onAdd(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
        >
          <div className="dz-icon">
            <PaperclipIcon />
          </div>
          <div className="dz-main">Drag &amp; drop files here</div>
          <div className="dz-sub">or click to browse</div>
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept={ACCEPT}
            onChange={(e) => {
              if (e.target.files?.length) onAdd(e.target.files);
              e.target.value = "";
            }}
          />
        </div>

        {pending.length > 0 && (
          <ul className="filelist">
            {pending.map((f, i) => (
              <li key={i} className="fileitem">
                <span className="fi-name">📄 {f.name}</span>
                <span className="fi-size">{formatSize(f.size)}</span>
                <button className="fi-remove" onClick={() => onRemove(i)} disabled={busy}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="upload-actions">
          <button className="ghost-btn" onClick={onBack} disabled={busy}>
            Back to chat
          </button>
          <button className="primary-btn" onClick={onSubmit} disabled={busy}>
            {busy
              ? "Sending…"
              : pending.length
              ? `Send ${pending.length} document${pending.length > 1 ? "s" : ""} to a lawyer`
              : "Skip & send to a lawyer"}
          </button>
        </div>
      </div>
    </div>
  );
}

function DoneScreen({ result, onShowDossier, loading }) {
  const files = result?.stored || [];
  return (
    <div className="tone-screen">
      <div className="tone-inner done-inner">
        <div className="done-check">✓</div>
        <h1 className="tone-title">Your case has been sent</h1>
        <p className="tone-sub">
          Thank you. A lawyer will review your situation
          {files.length ? " and the documents you provided" : ""} and be in touch
          shortly.
        </p>
        {files.length > 0 && (
          <ul className="filelist done-files">
            {files.map((name, i) => (
              <li key={i} className="fileitem">
                <span className="fi-name">📄 {name}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="upload-actions">
          <button className="primary-btn" onClick={onShowDossier} disabled={loading}>
            {loading ? "Building case file…" : "View case file →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// --- Case file (synthesis header + chronological timeline) ------------------

const CATEGORY_LABELS = {
  agreement: "Agreement",
  payment: "Payment",
  communication: "Communication",
  breach: "Breach",
  notice: "Notice",
  complaint: "Complaint",
  legal_action: "Legal action",
  decision: "Decision",
  deadline: "Deadline",
  incident: "Incident",
  other: "Event",
};

function formatMoney(m) {
  if (!m) return null;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency: m.currency || "GBP",
      maximumFractionDigits: m.amount % 1 === 0 ? 0 : 2,
    }).format(m.amount);
  } catch {
    return `${m.currency || "GBP"} ${m.amount}`;
  }
}

function DossierScreen({ data, onBack }) {
  if (!data || data.error) {
    return (
      <div className="tone-screen">
        <div className="tone-inner">
          <h1 className="tone-title">Couldn't build the case file</h1>
          <p className="tone-sub">Please try again in a moment.</p>
          <div className="upload-actions">
            <button className="ghost-btn" onClick={onBack}>
              Back
            </button>
          </div>
        </div>
      </div>
    );
  }

  const events = data.events || [];
  const amount = formatMoney(data.amount_in_dispute);

  return (
    <div className="dossier-screen">
      <header className="topbar">
        <button className="finish-btn dossier-back" onClick={onBack}>
          ← Back
        </button>
        <div className="brand">
          <span className="dot" />
          Case file
        </div>
      </header>

      <main className="dossier">
        <section className="case-header">
          <div className="case-type">{data.matter_type}</div>
          {data.summary && <p className="case-summary">{data.summary}</p>}

          <div className="case-facts">
            {data.parties?.length > 0 && (
              <div className="fact-block">
                <div className="fact-label">Parties</div>
                <div className="chips">
                  {data.parties.map((p, i) => (
                    <span key={i} className="chip">
                      <strong>{p.name}</strong>
                      {p.role ? ` — ${p.role}` : ""}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {amount && (
              <div className="fact-block">
                <div className="fact-label">Amount in dispute</div>
                <div className="fact-value">{amount}</div>
              </div>
            )}
            {data.next_deadline && (
              <div className="fact-block">
                <div className="fact-label">Next deadline</div>
                <div className="fact-value deadline">
                  {data.next_deadline.label}
                  {data.next_deadline.date_text ? ` · ${data.next_deadline.date_text}` : ""}
                </div>
              </div>
            )}
          </div>
        </section>

        <section className="timeline">
          {events.map((e, i) => (
            <TimelineItem key={i} event={e} />
          ))}
          {events.length === 0 && (
            <p className="tone-sub">No dated events were found.</p>
          )}
        </section>
      </main>
    </div>
  );
}

function TimelineItem({ event: e }) {
  const amount = formatMoney(e.amount);
  return (
    <div className="tl-item">
      <div className="tl-rail">
        <span className="tl-dot" />
      </div>
      <div className="tl-body">
        <div className="tl-date">{e.date_text || "Date unknown"}</div>
        <div className="tl-title">{e.title}</div>
        {e.detail && <div className="tl-detail">{e.detail}</div>}
        <div className="tl-meta">
          <span className={"badge cat-" + e.category}>
            {CATEGORY_LABELS[e.category] || "Event"}
          </span>
          {e.disputed && <span className="badge disputed">Disputed</span>}
          {e.is_deadline && <span className="badge deadline">Deadline</span>}
          {amount && <span className="tl-amount">{amount}</span>}
          {e.parties?.length > 0 && (
            <span className="tl-parties">{e.parties.join(", ")}</span>
          )}
          {e.source && <span className="tl-source">{e.source}</span>}
        </div>
      </div>
    </div>
  );
}

function Message({ role, text, file }) {
  if (role === "user") {
    return (
      <div className="row user">
        <div className={"bubble" + (file ? " file" : "")}>{text}</div>
      </div>
    );
  }
  return (
    <div className="row agent">
      <div className="agent-text">{text}</div>
    </div>
  );
}

function Typing() {
  return (
    <div className="row agent">
      <div className="typing">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function PaperclipIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}
