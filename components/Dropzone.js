"use client";
import { useCallback, useRef, useState } from "react";

// A click-or-drop file input. `filled` swaps the label to the loaded state.
export default function Dropzone({
  accept, multiple, onFiles, compact,
  icon, title, hint, filled, filledLabel,
}) {
  const inputRef = useRef(null);
  const [over, setOver] = useState(false);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setOver(false);
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
      onFiles(e.dataTransfer.files);
    }
  }, [onFiles]);

  const cls = ["dz"];
  if (compact) cls.push("dz--compact");
  if (over) cls.push("is-over");
  if (filled) cls.push("is-filled");

  return (
    <button
      type="button"
      className={cls.join(" ")}
      onClick={() => inputRef.current && inputRef.current.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      <span className="dz__icon" aria-hidden="true">{filled ? "✓" : icon}</span>
      <span className="dz__body">
        <span className="dz__title">{filled ? filledLabel : title}</span>
        {!compact && hint && <span className="dz__hint">{hint}</span>}
      </span>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        onChange={(e) => {
          if (e.target.files && e.target.files.length) onFiles(e.target.files);
          e.target.value = "";
        }}
      />
    </button>
  );
}
