import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { IScannerControls } from "@zxing/browser";

export function CameraScanButton({ onScan, disabled = false, maxLength = 512 }: {
  onScan: (code: string) => void; disabled?: boolean; maxLength?: number;
}) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [preview, setPreview] = useState<HTMLVideoElement | null>(null);
  const received = useRef(onScan);
  received.current = onScan;
  useEffect(() => {
    if (!open || disabled || !preview) return;
    let active = true;
    let controls: IScannerControls | undefined;
    const stop = () => {
      controls?.stop();
      const stream = preview?.srcObject as MediaStream | null;
      stream?.getTracks?.().forEach(track => track.stop());
      if (preview) preview.srcObject = null;
    };
    setError(""); setStarting(true);
    async function start() {
      if (!preview || !navigator.mediaDevices?.getUserMedia) {
        setError("Camera scanning is unavailable in this browser. Enter the label or use a handheld scanner.");
        setStarting(false); return;
      }
      try {
        const { BrowserMultiFormatReader } = await import("@zxing/browser");
        if (!active) return;
        const reader = new BrowserMultiFormatReader();
        controls = await reader.decodeFromConstraints({ audio: false, video: { facingMode: { ideal: "environment" } } }, preview, (result, _failure, scanner) => {
          if (!active || !result) return;
          const code = result.getText().trim();
          if (!code || code.length > maxLength || /[\p{Cc}]/u.test(code)) {
            setError("This label could not be read as a supported product or location code. Try another label or enter it manually.");
            return;
          }
          active = false;
          scanner.stop(); stop();
          received.current(code);
          setOpen(false);
        });
        if (!active) stop(); else setStarting(false);
      } catch (failure) {
        if (!active) return;
        stop(); setStarting(false);
        setError(failure instanceof DOMException && failure.name === "NotAllowedError"
          ? "Camera access was not allowed. Enter the label or use a handheld scanner."
          : "The camera could not be opened. Check camera access, or enter the label manually.");
      }
    }
    void start();
    return () => { active = false; stop(); };
  }, [open, disabled, maxLength, preview]);
  return <>
    <Button type="button" variant="outline" disabled={disabled} onClick={() => setOpen(true)}><Camera className="mr-2 h-4 w-4" />Scan with camera</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent>
      <DialogHeader><DialogTitle>Scan a label</DialogTitle><DialogDescription>Point your camera at a barcode. Review the detected code before recording any stock changes.</DialogDescription></DialogHeader>
      <video ref={setPreview} autoPlay playsInline muted aria-label="Barcode camera preview" className="aspect-video w-full rounded-md bg-slate-950 object-contain" />
      {starting && <p role="status" className="text-sm">Opening camera…</p>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <p className="text-sm text-muted-foreground">Camera images stay on this device. You can also enter a label or use a handheld scanner.</p>
      <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel scan</Button>
    </DialogContent></Dialog>
  </>;
}
