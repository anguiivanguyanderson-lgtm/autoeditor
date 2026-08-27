"use client";
import { useEffect, useRef, useState } from "react";

// A single themed modal that replaces the browser's alert/prompt/confirm.
// Imperative + promise-based so callers read like the natives they replace:
//   await showConfirm("Delete this?", { danger: true });
//   const name = await showPrompt("Rename", { defaultValue: "Untitled" });
//   await showAlert("Something went wrong");
// Resolves: confirm -> true/false, prompt -> string|null, alert -> undefined.

let emit = null; // set by the mounted DialogHost

function open(opts) {
  return new Promise((resolve) => {
    if (!emit) { resolve(opts.type === "prompt" ? null : opts.type === "confirm" ? false : undefined); return; }
    emit({ ...opts, resolve });
  });
}
export const showAlert = (message, opts = {}) => open({ type: "alert", message, okText: "OK", ...opts });
export const showConfirm = (message, opts = {}) => open({ type: "confirm", message, okText: "Confirm", cancelText: "Cancel", ...opts });
export const showPrompt = (message, opts = {}) => open({ type: "prompt", message, okText: "Save", cancelText: "Cancel", ...opts });

export function DialogHost() {
  const [state, setState] = useState(null);
  const [value, setValue] = useState("");
  const inputRef = useRef(null);

  const [copied, setCopied] = useState(false);
  useEffect(() => { emit = setState; return () => { emit = null; }; }, []);
  useEffect(() => {
    if (!state) return;
    setCopied(false);
    if (state.type === "prompt") setValue(state.defaultValue || "");
    const t = setTimeout(() => { if (inputRef.current) { inputRef.current.focus(); inputRef.current.select(); } }, 0);
    return () => clearTimeout(t);
  }, [state]);
  const copyDetails = async () => {
    try { await navigator.clipboard.writeText(state.details || ""); setCopied(true); setTimeout(() => setCopied(false), 1600); }
    catch (_) { /* clipboard blocked — the text is still selectable in the box */ }
  };

  if (!state) return null;

  const finish = (result) => { const r = state.resolve; setState(null); if (r) r(result); };
  const onCancel = () => finish(state.type === "prompt" ? null : state.type === "confirm" ? false : undefined);
  const onOk = () => finish(state.type === "prompt" ? value : state.type === "confirm" ? true : undefined);
  const onKeyDown = (e) => {
    if (e.key === "Escape") { e.preventDefault(); onCancel(); }
    else if (e.key === "Enter" && state.type !== "alert") { e.preventDefault(); onOk(); }
  };

  return (
    <div className="dlg-overlay" onMouseDown={onCancel}>
      <div
        className="dlg" role="dialog" aria-modal="true" aria-label={state.title || "Dialog"}
        onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}
      >
        {state.title && <div className="dlg__title">{state.title}</div>}
        {state.message && <div className="dlg__msg">{state.message}</div>}
        {state.details && (
          <div className="dlg__logs">
            <div className="dlg__logs-head">
              <span>Details</span>
              <button type="button" className="dlg__logs-copy" onClick={copyDetails}>{copied ? "Copied ✓" : "Copy"}</button>
            </div>
            <pre className="dlg__logs-pre">{state.details}</pre>
          </div>
        )}
        {state.type === "prompt" && (
          <input
            ref={inputRef} className="dlg__input" value={value}
            placeholder={state.placeholder || ""}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="dlg__actions">
          {state.type !== "alert" && (
            <button className="dlg__btn" onClick={onCancel}>{state.cancelText || "Cancel"}</button>
          )}
          <button
            ref={state.type === "alert" ? inputRef : null}
            className={`dlg__btn ${state.danger ? "dlg__btn--danger" : "dlg__btn--primary"}`}
            onClick={onOk}
          >
            {state.okText || "OK"}
          </button>
        </div>
      </div>
    </div>
  );
}
