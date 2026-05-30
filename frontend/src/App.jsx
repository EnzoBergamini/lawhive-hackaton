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

export default function App() {
  const [phase, setPhase] = useState("tone"); // "tone" | "domain" | "chat"
  const [tones, setTones] = useState([]);
  const [tone, setTone] = useState(null);
  const [domain, setDomain] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
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
    } catch {
      setMessages((m) => [...m, { role: "agent", text: "Something went wrong. Please try again." }]);
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files) {
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Intake Agent
        </div>
        {domain && (
          <span className="domain-badge">
            <span className="badge-icon">{domain.icon}</span>
            {domain.label}
          </span>
        )}
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
            accept=".pdf,.png,.jpg,.jpeg,.webp,.txt,.doc,.docx"
            onChange={(e) => {
              uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
        <p className="disclaimer">
          The Intake Agent gathers information for a lawyer. It does not provide legal advice.
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
          Intake Agent
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
          Intake Agent
        </span>
        <div className="step-hint">Step 2 of 2</div>
        <h1 className="tone-title">What area of law does this relate to?</h1>
        <p className="tone-sub">
          Pick the area that best fits your situation.
        </p>
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
