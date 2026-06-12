"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Push-to-Talk-Komplettdiktat: grosser Button, halten = sprechen.
 *
 * - Nimmt IMMER Audio auf (MediaRecorder) – Beleg + Futter fuer die
 *   on-prem Whisper-Transkription im Worker (offlinefaehig via Queue).
 * - Liefert ZUSAETZLICH ein Live-Transkript ueber die SpeechRecognition-API,
 *   wenn der Browser sie anbietet (gleiche API, die die Feld-Diktate dieser
 *   App bereits nutzen) – damit fuellt der Slot-Parser die Felder sofort.
 * - Pegelanzeige + Vibration, min. 0,5 s, max. 60 s.
 */

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
};

type SpeechWindow = {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const candidate of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"]) {
    if (MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

export function PushToTalk({
  onResult,
}: {
  onResult: (blob: Blob | null, mimeType: string, transcript: string) => void;
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
  const speechRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");

  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(rafRef.current);
    recorderRef.current?.stream.getTracks().forEach((track) => track.stop());
    audioCtxRef.current?.close().catch(() => undefined);
    try {
      speechRef.current?.stop();
    } catch {
      /* optional */
    }
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  function startSpeech() {
    const speechWindow = window as unknown as SpeechWindow;
    const Ctor = speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
    if (!Ctor) return;
    try {
      const recognition = new Ctor();
      recognition.lang = "de-DE";
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        let text = "";
        for (let index = 0; index < event.results.length; index += 1) {
          text += `${event.results[index]?.[0]?.transcript ?? ""} `;
        }
        transcriptRef.current = text.trim();
      };
      recognition.onerror = () => undefined;
      recognition.start();
      speechRef.current = recognition;
    } catch {
      speechRef.current = null;
    }
  }

  async function start() {
    if (recording) return;
    setError("");
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("Mikrofon nicht verfuegbar (HTTPS noetig) – Felder unten manuell ausfuellen.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      chunksRef.current = [];
      transcriptRef.current = "";
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        cancelAnimationFrame(rafRef.current);
        audioCtxRef.current?.close().catch(() => undefined);
        audioCtxRef.current = null;
        try {
          speechRef.current?.stop();
        } catch {
          /* optional */
        }
        const duration = (Date.now() - startedAtRef.current) / 1000;
        // SpeechRecognition liefert das letzte Endergebnis manchmal erst
        // kurz nach stop() – kleiner Puffer, dann Ergebnis melden.
        window.setTimeout(() => {
          if (duration < 0.5) {
            setAudioUrl("");
            onResult(null, "", "");
            setError("Zu kurz – Button zum Sprechen gedrueckt halten.");
            return;
          }
          const type = recorder.mimeType || mimeType || "audio/webm";
          const blob = new Blob(chunksRef.current, { type });
          if (audioUrl) URL.revokeObjectURL(audioUrl);
          setAudioUrl(URL.createObjectURL(blob));
          onResult(blob, type, transcriptRef.current);
        }, 350);
      };

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

      startSpeech();
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
      setError("Mikrofonzugriff verweigert – Felder unten manuell ausfuellen.");
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
    onResult(null, "", "");
  }

  return (
    <div className="ptt">
      {audioUrl && !recording ? (
        <div className="ptt-review">
          <audio controls src={audioUrl} />
          <button type="button" className="ptt-discard" onClick={discard}>Aufnahme verwerfen</button>
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
          {recording ? `Aufnahme laeuft … ${seconds}s (loslassen = fertig)` : audioUrl ? "Erneut diktieren (halten)" : "Halten und alles diktieren"}
        </span>
      </button>
      {error ? <p className="ptt-error">{error}</p> : null}
    </div>
  );
}
