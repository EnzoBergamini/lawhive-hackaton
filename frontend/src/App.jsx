import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

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
  const [phase, setPhase] = useState("welcome"); // welcome | tone | domain | chat | upload | done | dossier
  const [name, setName] = useState("");
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
  const [assessment, setAssessment] = useState(null); // null = not loaded yet
  const [assessmentLoading, setAssessmentLoading] = useState(false);
  const scrollRef = useRef(null);
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

  // DEV: when BY_PASS_INTAKE is set on the backend, skip the welcome/tone/domain
  // screens and the chat, then jump straight to the timeline using a preloaded
  // sample case — so we can iterate on the case file without doing the intake.
  useEffect(() => {
    (async () => {
      try {
        const cfg = await (await fetch("/api/config")).json();
        if (!cfg.bypass) return;
        await fetch("/api/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId, tone: "plain_english", name: "Dev" }),
        });
        showDossier();
      } catch {
        /* bypass is best-effort; fall back to the normal flow */
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
        body: JSON.stringify({ session_id: sessionId, tone, name }),
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

  // Extract the structured case file (synthesis + timeline) and show it; the
  // written assessment is fetched separately afterwards so the timeline appears
  // first while the assessment loads.
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
      loadAssessment();
    } catch {
      setDossier({ error: true });
      setPhase("dossier");
    } finally {
      setLoadingDossier(false);
    }
  }

  // Deferred: the plain-English assessment, loaded after the timeline is shown.
  async function loadAssessment() {
    setAssessment(null);
    setAssessmentLoading(true);
    try {
      const res = await fetch("/api/assessment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId }),
      });
      const data = await res.json();
      setAssessment(data.case_assessment || "");
    } catch {
      setAssessment("");
    } finally {
      setAssessmentLoading(false);
    }
  }

  // Manually add an event to the timeline; the backend returns the updated
  // case file (re-sorted) which replaces the dossier in place.
  async function addEvent(fields) {
    const res = await fetch("/api/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: sessionId, ...fields }),
    });
    if (!res.ok) throw new Error("Failed to add event");
    setDossier(await res.json());
  }

  function onKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  if (phase === "welcome") {
    return (
      <WelcomeScreen
        name={name}
        onChange={setName}
        onContinue={() => setPhase("tone")}
      />
    );
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
    return (
      <DossierScreen
        data={dossier}
        assessment={assessment}
        assessmentLoading={assessmentLoading}
        onBack={() => setPhase("done")}
        onAddEvent={addEvent}
      />
    );
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
        </div>
        <DisclaimerFooter />
      </footer>
    </div>
  );
}

function DisclaimerFooter() {
  return (
    <p className="global-disclaimer">
      Clearfile provides general legal information to help you understand and organise your
      situation. It is not a law firm and does not provide regulated legal advice. Clearfile can
      make mistakes — always check anything important with a qualified solicitor or a free service
      such as Citizens Advice, Shelter, or the relevant ombudsman before you act, sign, or file.
      Using Clearfile does not create a solicitor–client relationship.
    </p>
  );
}

function WelcomeScreen({ name, onChange, onContinue }) {
  const ready = name.trim().length > 0;
  return (
    <div className="tone-screen">
      <div className="tone-inner welcome-inner">
        <span className="brand center">
          <span className="dot" />
          CLEARFILE
        </span>
        <h1 className="tone-title">Before you start — please read this</h1>

        <div className="disclaimer-body">
          <p>
            Clearfile is a tool that helps you understand your situation, organise your documents
            into a timeline, and prepare draft letters and next steps. It is not a law firm, it is
            not your solicitor, and it does not provide regulated legal advice.
          </p>
          <p>
            The information and documents Clearfile produces are a starting point, not a final legal
            opinion. Clearfile uses AI and can make mistakes, including about the law, deadlines, and
            your specific circumstances. Time limits in legal matters are strict and missing one can
            permanently affect your rights — always confirm any deadline with a qualified adviser.
          </p>
          <p>
            Before you send a letter, sign a form, or start a claim, have your case checked by a
            qualified solicitor or a free service such as Citizens Advice, Shelter, or the relevant
            ombudsman. Clearfile can help you pass everything you've prepared to a lawyer.
          </p>
          <p>
            You upload your documents and information yourself, and you remain responsible for
            deciding what to do. Using Clearfile does not create a solicitor–client relationship.
          </p>
          <p>
            Your documents may include sensitive personal information. We process it only to help
            with your case and keep each case private and separate.{" "}
            <a href="#" className="privacy-link">
              Privacy notice
            </a>
            .
          </p>
        </div>

        <div className="name-field">
          <label className="name-label" htmlFor="client-name">
            Your name
          </label>
          <input
            id="client-name"
            className="name-input"
            type="text"
            value={name}
            placeholder="e.g. Jamie Watson"
            autoComplete="name"
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) onContinue();
            }}
          />
        </div>

        <div className="upload-actions">
          <button className="primary-btn" onClick={onContinue} disabled={!ready}>
            I understand — Continue
          </button>
        </div>

        <DisclaimerFooter />
      </div>
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
        <DisclaimerFooter />
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
        <DisclaimerFooter />
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
        <DisclaimerFooter />
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
        <DisclaimerFooter />
      </div>
    </div>
  );
}

// --- Case file (synthesis header + chronological timeline) ------------------

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

function DossierScreen({ data, assessment, assessmentLoading, onBack, onAddEvent }) {
  const [adding, setAdding] = useState(null); // null | { date }
  const [docsOpen, setDocsOpen] = useState(false);
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
  const documents = data.documents || [];

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
        {documents.length > 0 && (
          <button className="docs-launcher" onClick={() => setDocsOpen(true)}>
            <DocIcon />
            Documents
            <span className="docs-count">{documents.length}</span>
          </button>
        )}
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

        {(assessmentLoading || assessment) && (
          <section className="case-assessment">
            <div className="ca-label">Case assessment</div>
            {assessmentLoading ? (
              <div className="ca-loading">
                <span className="ca-spinner" />
                Analysing your case…
              </div>
            ) : (
              assessment
                .split(/\n+/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p, i) => (
                  <p key={i} className="ca-p">
                    {p}
                  </p>
                ))
            )}
          </section>
        )}

        <div className="tl-toolbar">
          <h2 className="tl-heading">Timeline</h2>
          <button className="add-event-btn" onClick={() => setAdding({ date: "" })}>
            + Add event
          </button>
        </div>
        <p className="tl-hint-text">Tip: in the “To scale” view, click anywhere on the timeline to add an event at that date.</p>

        <Timeline
          events={events}
          obligations={data.obligations || []}
          onPickDate={(date) => setAdding({ date })}
        />

        <DisclaimerFooter />
      </main>

      {adding && (
        <AddEventModal
          initialDate={adding.date}
          onClose={() => setAdding(null)}
          onSubmit={onAddEvent}
        />
      )}

      <DocumentsDrawer
        documents={documents}
        events={events}
        open={docsOpen}
        onClose={() => setDocsOpen(false)}
      />

      <DossierChat matter={data.matter_type} />
    </div>
  );
}

// Floating side chat to discuss the case file. Answers come from the backend,
// grounded in the current dossier (timeline, parties, obligations…).
function DossierChat({ matter }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy, open]);

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    setMessages((m) => [...m, { role: "user", text }]);
    setInput("");
    setBusy(true);
    try {
      const res = await fetch("/api/dossier/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: sessionId, message: text }),
      });
      const data = await res.json();
      setMessages((m) => [...m, { role: "agent", text: data.reply || "…" }]);
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Sorry, I couldn't answer just now." }]);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button className="chat-launcher" onClick={() => setOpen(true)}>
        <ChatIcon />
        Ask about this case
      </button>
    );
  }

  return (
    <div className="chat-panel">
      <header className="chat-head">
        <div className="chat-head-title">
          <ChatIcon />
          <span>Ask about this case</span>
        </div>
        <button className="chat-close" onClick={() => setOpen(false)} aria-label="Close chat">
          ✕
        </button>
      </header>

      <div className="chat-body" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="chat-empty">
            <p>Ask anything about this case file.</p>
            <div className="chat-suggestions">
              {[
                "Summarise this case in one line",
                "What deadlines were missed?",
                "How much could I claim?",
              ].map((s) => (
                <button key={s} className="chat-suggestion" onClick={() => setInput(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={"chat-msg " + m.role}>
            {m.text}
          </div>
        ))}
        {busy && (
          <div className="chat-msg agent">
            <span className="typing">
              <span />
              <span />
              <span />
            </span>
          </div>
        )}
      </div>

      <div className="chat-composer">
        <input
          value={input}
          placeholder="Ask about this case…"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button className="chat-send" onClick={send} disabled={busy || !input.trim()}>
          <ArrowUpIcon />
        </button>
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

// Collapsible right drawer listing the case documents. Each document shows its
// type + description, a hover preview, and the events that cite it (with the
// locator inside the document). Clicking a reference opens the doc at its page.
function DocumentsDrawer({ documents = [], events = [], open, onClose }) {
  // Group the events that cite each document, by filename.
  const refsByDoc = {};
  for (const e of events) {
    if (e.source && e.citation) {
      (refsByDoc[e.source] ||= []).push(e);
    }
  }

  return (
    <>
      <div
        className={"docs-scrim" + (open ? " show" : "")}
        onClick={onClose}
        aria-hidden={!open}
      />
      <aside className={"docs-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <header className="docs-head">
          <div className="docs-head-title">
            <DocIcon />
            <span>Documents</span>
            <span className="docs-count">{documents.length}</span>
          </div>
          <button className="chat-close" onClick={onClose} aria-label="Close documents">
            ✕
          </button>
        </header>

        <div className="docs-body">
          {documents.length === 0 && <p className="tone-sub">No documents in this case.</p>}
          {documents.map((d) => {
            const refs = refsByDoc[d.name] || [];
            return (
              <div key={d.name} className="doc-card">
                <div className="doc-type">{d.doc_type}</div>
                <SourceLink source={d.name} />
                <p className="doc-desc">{d.description}</p>
                {refs.length > 0 && (
                  <div className="doc-refs">
                    <div className="doc-refs-label">Used in {refs.length} event{refs.length > 1 ? "s" : ""}</div>
                    {refs.map((e, i) => (
                      <a
                        key={i}
                        className="doc-ref"
                        href={
                          docUrl(d.name) + (e.citation?.page ? `#page=${e.citation.page}` : "")
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        <span className="doc-ref-title">{e.title}</span>
                        <span className="doc-ref-loc">
                          <PinIcon />
                          {e.citation.location}
                          {e.citation.page ? ` · p.${e.citation.page}` : ""}
                        </span>
                        {e.citation.quote && (
                          <span className="doc-ref-quote">“{e.citation.quote}”</span>
                        )}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}

const CATEGORIES = [
  "agreement",
  "payment",
  "communication",
  "breach",
  "notice",
  "complaint",
  "legal_action",
  "decision",
  "deadline",
  "incident",
  "other",
];

function AddEventModal({ onClose, onSubmit, initialDate = "" }) {
  const [form, setForm] = useState({
    title: "",
    date: initialDate || "",
    detail: "",
    category: "other",
    disputed: false,
    is_deadline: false,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const set = (k) => (e) =>
    setForm((f) => ({
      ...f,
      [k]: e.target.type === "checkbox" ? e.target.checked : e.target.value,
    }));

  async function submit(e) {
    e.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await onSubmit(form);
      onClose();
    } catch {
      setError("Couldn't add the event. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <form
        className="modal"
        onClick={(e) => e.stopPropagation()}
        onSubmit={submit}
      >
        <h2 className="modal-title">Add an event</h2>

        <label className="field">
          <span className="field-label">Title *</span>
          <input
            className="field-input"
            value={form.title}
            placeholder="e.g. Deposit returned in full"
            autoFocus
            onChange={set("title")}
          />
        </label>

        <div className="field-row">
          <label className="field">
            <span className="field-label">Date</span>
            <input
              className="field-input"
              type="date"
              value={form.date}
              onChange={set("date")}
            />
          </label>
          <label className="field">
            <span className="field-label">Category</span>
            <select className="field-input" value={form.category} onChange={set("category")}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c.replace("_", " ")}
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="field">
          <span className="field-label">Detail</span>
          <textarea
            className="field-input"
            rows={3}
            value={form.detail}
            placeholder="A short description of what happened."
            onChange={set("detail")}
          />
        </label>

        <div className="field-checks">
          <label className="check">
            <input type="checkbox" checked={form.disputed} onChange={set("disputed")} />
            Disputed
          </label>
          <label className="check">
            <input type="checkbox" checked={form.is_deadline} onChange={set("is_deadline")} />
            Deadline
          </label>
        </div>

        {error && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="ghost-btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="primary-btn" disabled={busy || !form.title.trim()}>
            {busy ? "Adding…" : "Add event"}
          </button>
        </div>
      </form>
    </div>
  );
}

function docUrl(source) {
  return `/api/document?session_id=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(source)}`;
}

// --- Scaled timeline --------------------------------------------------------
// The central line represents time: events are grouped by date (so events on
// the SAME date share one node), and the vertical gap between consecutive
// groups is proportional to the real time elapsed between them.

const DAY_MS = 86400000;
const MIN_GAP = 64; // px — keeps close dates readable
const SCALE = 260; // px — vertical span given to the largest single gap

// Build the date-grouped, time-scaled structure. Events and obligation due
// dates share the axis: an obligation is placed at its computed `due_date`, so
// a "within 30 days of X" deadline lands at the right point on the time scale,
// joining the same node when it falls on a date that already has events.
function buildTimeline(events = [], obligations = []) {
  const dated = events.filter((e) => e.date);
  const undated = events.filter((e) => !e.date);

  const byDate = new Map();
  const ensure = (date) => {
    if (!byDate.has(date))
      byDate.set(date, { date, ts: Date.parse(date), events: [], deadlines: [] });
    return byDate.get(date);
  };
  for (const e of dated) ensure(e.date).events.push(e);
  for (const o of obligations) if (o.due_date) ensure(o.due_date).deadlines.push(o);

  const groups = [...byDate.values()].sort((a, b) => a.ts - b.ts);

  // Days between each group and the previous one (0 for the first).
  const gapDays = groups.map((g, i) =>
    i === 0 ? 0 : Math.round((g.ts - groups[i - 1].ts) / DAY_MS)
  );
  const maxGap = Math.max(1, ...gapDays);

  return { groups, gapDays, maxGap, undated };
}

// Pixel offset above a group, linear in elapsed time (floored so close dates
// stay legible). This is what makes the timeline "to scale".
function gapToPx(days, maxGap) {
  if (!days) return 0;
  return Math.max(MIN_GAP, Math.round((days / maxGap) * SCALE));
}

// A human label for the elapsed time, shown in larger gaps.
function humaniseGap(days) {
  if (days < 7) return null;
  if (days < 31) return `~${Math.round(days / 7)} week${days >= 14 ? "s" : ""} later`;
  if (days < 365) return `~${Math.round(days / 30)} month${days >= 60 ? "s" : ""} later`;
  const years = days / 365;
  return `~${years.toFixed(years >= 2 ? 0 : 1)} year${years >= 1.5 ? "s" : ""} later`;
}

const COMPACT_GAP = 16; // px — uniform spacing in compact (non-scaled) mode

function tsToISO(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}
function tsToLabel(ts) {
  return new Date(ts).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function Timeline({ events = [], obligations = [], onPickDate }) {
  const [scaled, setScaled] = useState(true);
  const [hover, setHover] = useState(null); // { top, label } while pointing at the spine
  const sectionRef = useRef(null);
  const { groups, gapDays, maxGap, undated } = buildTimeline(events, obligations);

  if (groups.length === 0 && undated.length === 0) {
    return <p className="tone-sub">No events were found.</p>;
  }

  // Map a viewport Y to a timestamp by interpolating between the date nodes —
  // this is what makes a click on the spine resolve to a real (to-scale) date.
  function tsFromClientY(clientY) {
    const pills = sectionRef.current?.querySelectorAll(".tl-date-pill");
    if (!pills || pills.length === 0) return null;
    const pts = [...pills].map((el, i) => {
      const r = el.getBoundingClientRect();
      return { y: r.top + r.height / 2, ts: groups[i].ts };
    });
    if (clientY <= pts[0].y) return pts[0].ts;
    const last = pts[pts.length - 1];
    if (clientY >= last.y) return last.ts;
    for (let i = 0; i < pts.length - 1; i++) {
      if (clientY >= pts[i].y && clientY <= pts[i + 1].y) {
        const span = pts[i + 1].y - pts[i].y || 1;
        const frac = (clientY - pts[i].y) / span;
        return Math.round(pts[i].ts + frac * (pts[i + 1].ts - pts[i].ts));
      }
    }
    return last.ts;
  }

  const onCard = (target) =>
    target.closest &&
    target.closest(".tl-card, .tl-controls, .tl-undated, button, a, .tl-date-pill");

  function onMove(e) {
    if (!scaled || !onPickDate || onCard(e.target)) {
      setHover(null);
      return;
    }
    const ts = tsFromClientY(e.clientY);
    if (ts == null) return setHover(null);
    const top = e.clientY - sectionRef.current.getBoundingClientRect().top;
    setHover({ top, label: tsToLabel(ts) });
  }

  function onClick(e) {
    if (!scaled || !onPickDate || onCard(e.target)) return;
    const ts = tsFromClientY(e.clientY);
    onPickDate(ts == null ? "" : tsToISO(ts));
  }

  return (
    <>
      <div className="tl-controls">
        <div className="tl-seg" role="group" aria-label="Timeline spacing">
          <button
            className={scaled ? "active" : ""}
            onClick={() => setScaled(true)}
            aria-pressed={scaled}
          >
            To scale
          </button>
          <button
            className={!scaled ? "active" : ""}
            onClick={() => setScaled(false)}
            aria-pressed={!scaled}
          >
            Compact
          </button>
        </div>
      </div>

      <section
        ref={sectionRef}
        className={
          "timeline" + (scaled ? " scaled" : " compact") + (onPickDate && scaled ? " clickable" : "")
        }
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
        onClick={onClick}
      >
        {scaled && hover && (
          <div className="tl-addhint" style={{ top: hover.top }}>
            <span className="tl-addhint-plus">+</span>
            Add at {hover.label}
          </div>
        )}
        {groups.map((g, i) => {
          const side = i % 2 === 0 ? "tl-left" : "tl-right";
          // Elapsed-time labels only make sense in the to-scale view.
          const label = scaled ? humaniseGap(gapDays[i]) : null;
          // The date label: prefer an event's wording, else the deadline's.
          const dateText =
            g.events[0]?.date_text || g.deadlines[0]?.due_text || g.date;
          const marginTop =
            i === 0 ? 0 : scaled ? gapToPx(gapDays[i], maxGap) : COMPACT_GAP;
          return (
            <div key={g.date} className={"tl-group " + side} style={{ marginTop }}>
              {label && <span className="tl-gap">{label}</span>}
            <span className="tl-date-pill">{dateText}</span>
            <div className="tl-cards">
              {g.events.map((e, j) => (
                <TimelineCard key={"e" + j} event={e} />
              ))}
              {g.deadlines.map((o, j) => (
                <DeadlineCard key={"d" + j} obligation={o} />
              ))}
            </div>
          </div>
        );
      })}

        {undated.length > 0 && (
          <div className="tl-undated">
            <div className="tl-undated-label">Undated</div>
            <div className="tl-undated-cards">
              {undated.map((e, i) => (
                <TimelineCard key={i} event={e} />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

function TimelineCard({ event: e }) {
  const isManual = e.source === "Manual entry";
  const hasDoc = e.source && e.source !== "Conversation" && !isManual;
  return (
    <div className={"tl-card cat-" + e.category}>
      <div className="tl-title">{e.title}</div>
      {e.detail && <p className="tl-desc">{e.detail}</p>}
      {(e.disputed || e.is_deadline || isManual) && (
        <div className="tl-tags">
          {e.disputed && <span className="badge disputed">Disputed</span>}
          {e.is_deadline && <span className="badge deadline">Deadline</span>}
          {isManual && <span className="badge manual">Manual</span>}
        </div>
      )}
      {hasDoc && <SourceLink source={e.source} page={e.citation?.page} />}
      {hasDoc && e.citation && (
        <div className="tl-citation">
          <span className="tl-citation-loc">
            <PinIcon />
            {e.citation.location}
            {e.citation.page ? ` · p.${e.citation.page}` : ""}
          </span>
          {e.citation.quote && <span className="tl-citation-quote">“{e.citation.quote}”</span>}
        </div>
      )}
    </div>
  );
}

// A document link that previews its source on hover. Clicking still opens the
// full document in a new tab. The preview is a fixed-position popover so it is
// never clipped by the scrolling timeline, and flips side/clamps to stay on
// screen. The media (img / pdf iframe) only mounts while hovering.
function SourceLink({ source, page, label }) {
  const ref = useRef(null);
  const [pos, setPos] = useState(null); // { top, left } or null
  const base = docUrl(source);
  const isImage = /\.(png|jpe?g|webp|gif|bmp)$/i.test(source);
  const isPdf = /\.pdf$/i.test(source);
  const previewable = isImage || isPdf;
  // Deep-link a PDF to the cited page; the preview iframe gets the same anchor.
  const linkUrl = base + (isPdf && page ? `#page=${page}` : "");
  const previewUrl =
    base +
    "#" +
    [isPdf && page ? `page=${page}` : null, "toolbar=0", "navpanes=0", "view=FitH"]
      .filter(Boolean)
      .join("&");

  function show() {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const W = 340;
    const H = 420;
    let left = r.right + 12;
    if (left + W > window.innerWidth - 8) left = r.left - W - 12; // flip to the left
    left = Math.max(8, left);
    let top = r.top;
    if (top + H > window.innerHeight - 8) top = window.innerHeight - H - 8;
    top = Math.max(8, top);
    setPos({ top, left });
  }

  return (
    <>
      <a
        ref={ref}
        className="tl-doc"
        href={linkUrl}
        target="_blank"
        rel="noreferrer"
        onMouseEnter={previewable ? show : undefined}
        onMouseLeave={() => setPos(null)}
      >
        <DocIcon />
        <span className="tl-doc-name">{label || source}</span>
      </a>
      {pos &&
        previewable &&
        createPortal(
          // Rendered into <body> so `position: fixed` resolves against the
          // viewport — a transformed ancestor (the card's hover/animation
          // transform) would otherwise become its containing block.
          <div className="src-preview" style={{ top: pos.top, left: pos.left }}>
            {isImage ? (
              <img src={base} alt={source} />
            ) : (
              <iframe src={previewUrl} title={source} />
            )}
            <div className="src-preview-name">
              <DocIcon />
              {source}
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

const STATUS_LABEL = {
  met: "Met in time",
  missed: "Deadline missed",
  pending: "Window open",
  unknown: "Status unclear",
};

// A relative deadline: "do X within N days of [anchor]", shown at its computed
// due date. The status drives the colour (missed = red, met = green, …).
function DeadlineCard({ obligation: o }) {
  const status = o.status || "unknown";
  return (
    <div className={"tl-card tl-deadline status-" + status}>
      <div className="tl-deadline-head">
        <ClockIcon />
        <span className="tl-deadline-due">Due {o.due_text || "—"}</span>
        <span className={"badge status-" + status}>{STATUS_LABEL[status]}</span>
      </div>
      <div className="tl-title">{o.action}</div>
      <p className="tl-desc">
        Within {o.window_days} day{o.window_days === 1 ? "" : "s"} of {o.anchor_text}
        {o.basis ? ` · ${o.basis}` : ""}
      </p>
    </div>
  );
}

function DocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
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
