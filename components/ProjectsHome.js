"use client";
import { useState } from "react";
import { showConfirm, showPrompt } from "./Dialog";
import StorageRing from "./StorageRing";

function timeAgo(ts) {
  if (!ts) return "";
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60); if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60); if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24); if (d < 7) return `${d} day${d > 1 ? "s" : ""} ago`;
  return new Date(ts).toLocaleDateString();
}
function clock(sec) {
  if (!sec || !isFinite(sec)) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
export default function ProjectsHome({ projects, onNew, onOpen, onRename, onDelete, storage }) {
  const [menuId, setMenuId] = useState(null); // project id with its ⋮ menu open

  const doRename = async (p) => {
    setMenuId(null);
    const name = await showPrompt("Rename project", {
      title: "Rename project", defaultValue: p.name || "Untitled project", okText: "Rename",
    });
    if (name && name.trim()) onRename(p.id, name.trim());
  };
  const doDelete = async (p) => {
    setMenuId(null);
    const ok = await showConfirm(
      `Delete "${p.name || "Untitled"}"? This permanently removes the project and its media from this device.`,
      { title: "Delete project", okText: "Delete", danger: true }
    );
    if (ok) onDelete(p.id);
  };

  return (
    <main className="ph" onClick={() => menuId && setMenuId(null)}>
      <header className="ph__topbar">
        <div className="ph__bar">
          <div className="ph__brand">
            <img className="ph__logo" src="/logo.svg" alt="" width="26" height="26" />
            <span className="ph__name"><span className="ph__pre">TryAIToday</span> AutoEditor</span>
          </div>
          <div className="ph__actions">
            <a
              className="dc-link"
              href="https://discord.gg/5sxVBf3kx8"
              target="_blank" rel="noopener noreferrer"
              title="Join the TryAIToday Discord"
            >
              <svg className="dc-link__icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
                <path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/>
              </svg>
              <span className="dc-link__text">Discord</span>
            </a>
            <a
              className="ext-link"
              href="https://chromewebstore.google.com/detail/bcmmekkamenpjoogmegiffgemlgikbgf?utm_source=item-share-cb"
              target="_blank" rel="noopener noreferrer"
              title="Get the TryAIToday Flow Automator Chrome extension"
            >
              <span className="ext-link__icon" aria-hidden="true">🧩</span>
              <span className="ext-link__text">Get the Extension</span>
            </a>
            <StorageRing storage={storage} />
          </div>
        </div>
      </header>

      <div className="ph__body">
        <div className="ph__head">
          <h1 className="ph__title">Your projects</h1>
          <p className="ph__sub">Pick up where you left off — or start a fresh cut.</p>
        </div>

        <div className="ph__grid">
          <button className="ph__new" onClick={onNew}>
            <span className="ph__new-plus">＋</span>
            <span className="ph__new-label">New project</span>
          </button>

          {projects.map((p) => (
            <div key={p.id} className="pcard" onClick={() => onOpen(p.id)}>
              <div className="pcard__thumb">
                {p.thumb ? <img src={p.thumb} alt="" /> : <span className="pcard__noimg">▦</span>}
                {p.durationSec ? <span className="pcard__dur">{clock(p.durationSec)}</span> : null}
              </div>
              <div className="pcard__foot">
                <div className="pcard__meta">
                  <span className="pcard__name" title={p.name}>{p.name || "Untitled"}</span>
                  <span className="pcard__sub">
                    {p.clipCount ? `${p.clipCount} clip${p.clipCount > 1 ? "s" : ""} · ` : ""}{timeAgo(p.updatedAt)}
                  </span>
                </div>
                <div className="pcard__menuwrap" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="pcard__menu"
                    aria-label="Project options"
                    onClick={() => setMenuId(menuId === p.id ? null : p.id)}
                  >⋮</button>
                  {menuId === p.id && (
                    <div className="pcard__pop">
                      <button onClick={() => doRename(p)}>Rename</button>
                      <button className="pcard__pop-del" onClick={() => doDelete(p)}>Delete</button>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {projects.length === 0 && (
          <p className="ph__empty">No projects yet — create your first one to get started.</p>
        )}
      </div>
    </main>
  );
}
