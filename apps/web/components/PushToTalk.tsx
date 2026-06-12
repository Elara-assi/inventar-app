"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Push-to-Talk (D1): grosser Button, halten = sprechen, loslassen = fertig.
 * Live-Pegelanzeige + Vibration als spuerbares "es nimmt auf"-Feedback.
 * Grenzen: min. 0,5 s (versehentliches Tippen), max. 60 s.
 */

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

export function PushToTalk({
  onChange,
}: {
  onChange: (blob: Blob | null, mimeType: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [level, setLevel] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const rafRef = useRef(0);
  const audioCtxRef = useRef<AudioContext | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    audioCtxRef.current?.close().catch(() => undefined);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  async function start() {
    if (recording) return;
    setError("");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Mikrofon nicht verfuegbar (HTTPS noetig) – Notiz unten eintippen.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        cancelAnimationFrame(rafRef.current);
        audioCtxRef.current?.close().catch(() => undefined);
        audioCtxRef.current = null;
        const duration = (Date.now() - startedAtRef.current) / 1000;
        if (duration < 0.5) {
          setAudioUrl("");
          onChange(null, "");
          setError("Zu kurz – Button zum Sprechen gedrueckt halten.");
          return;
        }
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(blob));
        onChange(blob, type);
      };

      // Live-Pegel
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += (value - 128) ** 2;
        setLevel(Math.min(1, Math.sqrt(sum / data.length) / 40));
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);

      recorder.start();
      recorderRef.current = recorder;
      startedAtRef.current = Date.now();
      setRecording(true);
      setSeconds(0);
      navigator.vibrate?.(60);
      timerRef.current = setInterval(() => {
        setSeconds((value) => {
          if (value + 1 >= 60) stop();
          return value + 1;
        });
      }, 1000);
    } catch {
      setError("Mikrofonzugriff verweigert – Notiz unten eintippen.");
    }
  }

  function stop() {
    if (!recorderRef.current || recorderRef.current.state === "inactive") return;
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current.stop();
    setRecording(false);
    setLevel(0);
    navigator.vibrate?.(40);
  }

  function discard() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setSeconds(0);
    onChange(null, "");
  }

  return (
    <div className="ptt">
      {audioUrl && !recording ? (
        <div className="grid">
          <audio controls src={audioUrl} />
          <button className="btn ghost" onClick={discard}>Aufnahme verwerfen</button>
        </div>
      ) : null}
      <button
        type="button"
        className={`ptt-button${recording ? " recording" : ""}`}
        onPointerDown={(event) => {
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          start();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={() => recording && stop()}
        onContextMenu={(event) => event.preventDefault()}
      >
        <span className="ptt-level" style={{ transform: `scaleY(${0.15 + level * 0.85})` }} aria-hidden />
        <span className="ptt-label">
          {recording ? `Aufnahme laeuft … ${seconds}s (loslassen = fertig)` : audioUrl ? "Erneut diktieren (halten)" : "Halten und diktieren"}
        </span>
      </button>
      {error ? <p className="status upload_fehler">{error}</p> : null}
    </div>
  );
}
