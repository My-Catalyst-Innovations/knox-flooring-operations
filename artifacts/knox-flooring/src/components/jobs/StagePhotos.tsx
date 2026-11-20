import { useRef, useState } from "react";
import { fileSrc, supportedImageTypes, useStoredFileUpload } from "@/lib/file-upload";
import { useJobPhotos } from "@/hooks/use-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ImagePlus, Trash2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { STAGE_ORDER, formatStageDate } from "@/lib/stages";
import type { JobStatus } from "@/lib/types";

export function StagePhotos({
  jobId,
  currentStage,
}: {
  jobId: string;
  currentStage: JobStatus;
}) {
  const { photos, addPhoto, deletePhoto } = useJobPhotos(jobId);
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<JobStatus>(currentStage);
  const [caption, setCaption] = useState("");
  const [shareOnPortal, setShareOnPortal] = useState(false);

  const { uploadFile, isUploading } = useStoredFileUpload((err) => toast({
    title: "Photo could not be saved",
    description: err.message,
    variant: "destructive",
  }));

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await uploadFile(file, shareOnPortal ? "portal-photo" : "job-photo", jobId, async (objectPath) => {
      await addPhoto({ stage, objectPath, caption });
      setCaption("");
      setShareOnPortal(false);
      toast({ title: "Photo uploaded", description: `Added to "${stage}" stage.` });
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <Card data-training-id="job-photos">
      <CardHeader>
        <CardTitle>Job Photos</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid sm:grid-cols-[1fr_1.5fr_auto] gap-3 items-end bg-muted/30 p-4 rounded-md border">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Stage</label>
            <Select value={stage} onValueChange={(v: JobStatus) => setStage(v)}>
              <SelectTrigger className="bg-background">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STAGE_ORDER.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Caption (optional)</label>
            <Input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="e.g. Subfloor prep complete"
              className="bg-background"
            />
          </div>
          <Button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="w-4 h-4 mr-2 animate-spin" />
            ) : (
              <ImagePlus className="w-4 h-4 mr-2" />
            )}
            {isUploading ? "Uploading…" : "Upload"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept={supportedImageTypes}
            className="hidden"
            onChange={handleFile}
          />
          <label className="flex items-center gap-2 text-sm sm:col-span-3">
            <input type="checkbox" checked={shareOnPortal} onChange={(event) => setShareOnPortal(event.target.checked)} disabled={isUploading} />
            Share this photo on the customer portal
          </label>
        </div>

        {photos.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No photos yet. Upload progress photos for each stage.
          </p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            {photos.map((photo) => (
              <div
                key={photo.id}
                className="group relative rounded-md border overflow-hidden bg-muted/30"
              >
                <img
                  src={fileSrc(photo.objectPath)}
                  alt={photo.caption || photo.stage}
                  className="w-full h-36 object-cover"
                  loading="lazy"
                />
                <button
                  type="button"
                  onClick={() => deletePhoto(photo.id)}
                  className="absolute top-1.5 right-1.5 p-1.5 rounded-md bg-black/50 text-white transition-opacity hover:bg-destructive sm:opacity-0 sm:group-hover:opacity-100 focus:opacity-100"
                  aria-label="Delete photo"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
                <div className="p-2 space-y-1">
                  <Badge variant="secondary" className="text-[10px]">
                    {photo.stage}
                  </Badge>
                  {photo.objectPath.startsWith("/objects/files/portal-photo/") && <Badge variant="outline" className="ml-1 text-[10px]">Customer portal</Badge>}
                  {photo.caption && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {photo.caption}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground/70">
                    {formatStageDate(photo.createdAt)}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
