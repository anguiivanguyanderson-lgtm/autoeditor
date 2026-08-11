"use client";
import { useEffect, useRef } from "react";

// props: clips [{name,start,duration}], imageEls {name->HTMLImageElement},
//        audioUrl, width, height
export default function PreviewPlayer({ clips, imageEls, audioUrl, width, height }) {
  const canvasRef = useRef(null);
  const audioRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas.getContext("2d");

    function draw(t) {
      const clip = clips.find((c) => t >= c.start && t < c.start + c.duration) || clips[0];
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (!clip) return;
      const img = imageEls[clip.name];
      if (!img) return;
      // contain
      const scale = Math.min(canvas.width / img.naturalWidth, canvas.height / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      ctx.drawImage(img, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
    }

    const audio = audioRef.current;
    const onTime = () => draw(audio.currentTime);
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("seeked", onTime);
    draw(0);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("seeked", onTime);
    };
  }, [clips, imageEls]);

  return (
    <div>
      <canvas ref={canvasRef} width={width} height={height} className="preview" />
      <audio ref={audioRef} src={audioUrl} controls style={{ width: "100%", marginTop: 10 }} />
    </div>
  );
}
