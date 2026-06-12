"use client";

import { useEffect, useRef, useState } from "react";

/** Echte Sprachaufnahme per MediaRecorder (vorher: nur Textfeld).
 *  Waehlt den vom Geraet unterstuetzten Container (webm/Chrome, mp4/iOS). */

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

export function AudioRecorder({
  onChange,
}: {
  onChange: (blob: Blob | null, mimeType: string) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [audioUrl, setAudioUrl] = useState("");
  const [error, setError] = useState("");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  async function start() {
    setError("");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Audioaufnahme nicht verfuegbar – Notiz unten eintippen.");
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
        const type = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type });
        if (audioUrl) URL.revokeObjectURL(audioUrl);
        setAudioUrl(URL.createObjectURL(blob));
        onChange(blob, type);
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setSeconds(0);
      timerRef.current = setInterval(() => setSeconds((value) => value + 1), 1000);
    } catch {
      setError("Mikrofonzugriff verweigert – Notiz unten eintippen.");
    }
  }

  function stop() {
    if (timerRef.current) clearInterval(timerRef.current);
    recorderRef.current?.stop();
    setRecording(false);
  }

  function discard() {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    setAudioUrl("");
    setSeconds(0);
    onChange(null, "");
  }

  return (
    <div className="audio-recorder">
      {recording ? (
        <button className="btn danger big" onClick={stop}>
          Aufnahme stoppen ({seconds}s)
        </button>
      ) : audioUrl ? (
        <div className="grid">
          <audio controls src={audioUrl} />
          <div className="quick-row">
            <button className="btn secondary" onClick={start}>Neu aufnehmen</button>
            <button className="btn ghost" onClick={discard}>Verwerfen</button>
          </div>
        </div>
      ) : (
        <button className="btn secondary big" onClick={start}>Sprachnotiz aufnehmen</button>
      )}
      {error ? <p className="status upload_fehler">{error}</p> : null}
    </div>
  );
}
