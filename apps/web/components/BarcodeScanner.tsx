"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live-Barcode/QR-Scanner.
 * 1. Wahl: native BarcodeDetector-API (Android Chrome – sehr schnell).
 * 2. Fallback: @zxing/browser (iOS Safari u. a.), dynamisch nachgeladen.
 * Liefert den ersten stabilen Treffer und stoppt die Kamera sofort.
 */

type DetectorLike = {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string; format: string }>>;
};

declare global {
  interface Window {
    BarcodeDetector?: new (options?: { formats?: string[] }) => DetectorLike;
  }
}

const FORMATS = ["qr_code", "ean_13", "ean_8", "code_128", "code_39", "code_93", "data_matrix", "itf", "upc_a", "upc_e"];

export function BarcodeScanner({
  onDetected,
  onClose,
}: {
  onDetected: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [error, setError] = useState("");
  const [engine, setEngine] = useState("");
  const stoppedRef = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let zxingControls: { stop: () => void } | null = null;
    let rafId = 0;
    stoppedRef.current = false;

    function finish(code: string) {
      if (stoppedRef.current) return;
      stoppedRef.current = true;
      try {
        navigator.vibrate?.(120);
      } catch {
        /* optional */
      }
      cleanup();
      onDetected(code.trim());
    }

    function cleanup() {
      if (rafId) cancelAnimationFrame(rafId);
      zxingControls?.stop();
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    }

    async function start() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError("Kamera-API nicht verfuegbar. HTTPS noetig – Code unten manuell eingeben.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
      } catch {
        setError("Kamerazugriff verweigert – Code unten manuell eingeben.");
        return;
      }
      const video = videoRef.current;
      if (!video || stoppedRef.current) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      await video.play().catch(() => undefined);

      if (window.BarcodeDetector) {
        setEngine("Scanner aktiv");
        const detector = new window.BarcodeDetector({ formats: FORMATS });
        const tick = async () => {
          if (stoppedRef.current || !videoRef.current) return;
          try {
            if (videoRef.current.readyState >= 2) {
              const codes = await detector.detect(videoRef.current);
              if (codes.length && codes[0].rawValue) {
                finish(codes[0].rawValue);
                return;
              }
            }
          } catch {
            /* einzelner Frame-Fehler ist ok */
          }
          rafId = requestAnimationFrame(tick);
        };
        rafId = requestAnimationFrame(tick);
        return;
      }

      // Fallback ohne native API
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        setEngine("Scanner aktiv (Kompatibilitaetsmodus)");
        const reader = new BrowserMultiFormatReader();
        zxingControls = await reader.decodeFromVideoElement(video, (result) => {
          if (result) finish(result.getText());
        });
      } catch {
        setError("Scanner konnte nicht starten – Code unten manuell eingeben.");
      }
    }

    start();
    return () => {
      stoppedRef.current = true;
      cleanup();
    };
  }, [onDetected]);

  return (
    <div className="scanner-overlay">
      <div className="scanner-frame">
        <video ref={videoRef} playsInline muted />
        <div className="scanner-reticle" aria-hidden />
      </div>
      {error ? <p className="status upload_fehler">{error}</p> : <p className="muted">{engine || "Kamera startet…"} – Code ins Feld halten</p>}
      <button className="btn" onClick={onClose}>Scanner schliessen</button>
    </div>
  );
}
