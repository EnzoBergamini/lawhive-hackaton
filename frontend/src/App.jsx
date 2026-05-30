import { useEffect, useRef, useState } from "react";

const sessionId = "sess-" + Math.random().toString(36).slice(2);

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState(false);
  const scrollRef = useRef(null);
  const fileRef = useRef(null);
  const taRef = useRef(null);

  // Kick off the conversation once on load.
  useEffect(() => {
    (async () => {
      setBusy(true);
      try {
        const res = await fetch("/api/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ session_id: sessionId }),
        });
        const data = await res.json();
        setMessages([{ role: "agent", text: data.reply }]);
      } catch {
        setMessages([
          { role: "agent", text: "I couldn't connect. Is the server running?" },
        ]);
      } finally {
        setBusy(false);
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          Intake Agent
        </div>
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
