"use client";

function fmtBytes(n) {
  if (!n) return "0 MB";
  const mb = n / (1024 * 1024);
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

// Compact ring badge showing how much browser storage is free; hover/focus opens
// a "Storage balance" popover. Shared by the projects landing and the editor nav.
export default function StorageRing({ storage }) {
  if (!storage || !storage.quota) return null;
  const C = 2 * Math.PI * 15;
  const free = Math.max(0, storage.quota - storage.usage);
  const pctFree = Math.max(0, Math.min(1, free / storage.quota));
  const dash = C * pctFree;
  return (
    <div className="stor" tabIndex={0} aria-label="Storage balance">
      <div className="stor__badge">
        <svg viewBox="0 0 36 36" width="42" height="42" aria-hidden="true">
          <circle className="stor__track" cx="18" cy="18" r="15" />
          <circle className="stor__fill" cx="18" cy="18" r="15" strokeDasharray={`${dash} ${C - dash}`} />
        </svg>
        <span className="stor__num">{Math.round(pctFree * 100)}%</span>
      </div>
      <div className="stor__pop" role="tooltip">
        <div className="stor__pop-head"><span className="stor__pop-ico" aria-hidden="true">◌</span> Storage balance</div>
        <div className="stor__row"><span>Total</span><b>{fmtBytes(storage.quota)}</b></div>
        <div className="stor__row"><span>Remaining</span><b>{fmtBytes(free)}</b></div>
      </div>
    </div>
  );
}
