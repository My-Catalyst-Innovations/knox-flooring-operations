import { useEffect, useState, useId } from "react";
import { useStore } from "@/hooks/use-store";
import { useUnsavedForm } from "@/hooks/use-unsaved-changes";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { computeCosting, fmtMoney, jobCostingGaps } from "@/lib/costing";
import type { Job } from "@/lib/types";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  job: Job;
}

export function JobCostingDialog({ open, onOpenChange, job }: Props) {
  const { updateJob } = useStore();
  const { toast } = useToast();

  const [actualRevenue, setActualRevenue] = useState(0);
  const [actualLaborCost, setActualLaborCost] = useState(0);
  const [actualMaterialCost, setActualMaterialCost] = useState(0);
  const [actualAddOnCost, setActualAddOnCost] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const guard = useUnsavedForm(open, {
    actualRevenue,
    actualLaborCost,
    actualMaterialCost,
    actualAddOnCost,
  });
  const close = (next: boolean) => {
    if (!saving && (next || guard.confirmDiscard())) onOpenChange(next);
  };

  useEffect(() => {
    if (!open) return;
    setError("");
    guard.reset({
      actualRevenue: job.actualRevenue || 0,
      actualLaborCost: job.actualLaborCost || 0,
      actualMaterialCost: job.actualMaterialCost || 0,
      actualAddOnCost: job.actualAddOnCost || 0,
    });
    setActualRevenue(job.actualRevenue || 0);
    setActualLaborCost(job.actualLaborCost || 0);
    setActualMaterialCost(job.actualMaterialCost || 0);
    setActualAddOnCost(job.actualAddOnCost || 0);
  }, [open, job.id]);

  const previewJob = { ...job, actualRevenue, actualLaborCost, actualMaterialCost, actualAddOnCost };
  const { actualCost, actualGrossProfit: actualProfit, hasActualProfit: showProfit, actualMarginPct: actualMargin } = computeCosting(previewJob);
  const gaps = jobCostingGaps(previewJob);

  const handleSave = async () => {
    if (saving) return;
    setError("");
    if (
      ![
        actualRevenue,
        actualLaborCost,
        actualMaterialCost,
        actualAddOnCost,
      ].every((n) => Number.isFinite(n) && n >= 0)
    ) {
      setError("Enter nonnegative amounts for revenue and costs.");
      return;
    }
    setSaving(true);
    try {
      await updateJob(job.id, {
        actualRevenue,
        actualLaborCost,
        actualMaterialCost,
        actualAddOnCost,
      });
      toast({ title: "Actuals saved", description: "Job costing updated." });
      onOpenChange(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Save failed. Your amounts are still here.",
      );
    } finally {
      setSaving(false);
    }
  };

  const prefillFromEstimate = () => {
    setActualRevenue(job.estRevenue || 0);
    if (job.trackedLaborCost === undefined || job.trackedLaborCost === null) setActualLaborCost(job.laborEstimate || 0);
    if (job.trackedMaterialCost === undefined) setActualMaterialCost(job.materialEstimate || 0);
    setActualAddOnCost(0);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Record Actual Costs</DialogTitle>
          <DialogDescription>
            Capture what this job really cost and brought in, separate from the
            estimate.
          </DialogDescription>
        </DialogHeader>

        <fieldset disabled={saving} className="space-y-4">
          <NumberField
            label="Actual Revenue"
            value={actualRevenue}
            onChange={setActualRevenue}
            hint={`Estimated: ${fmtMoney(job.estRevenue || 0)}`}
          />
          <div className="grid grid-cols-2 gap-4">
            <NumberField
              label="Actual Labor"
              value={actualLaborCost}
              onChange={setActualLaborCost}
              hint={job.trackedLaborCost === undefined || job.trackedLaborCost === null
                ? `Estimated: ${fmtMoney(job.laborEstimate || 0)}`
                : `Reviewed labor: ${fmtMoney(job.trackedLaborCost)}. Enter zero to use the reviewed total; a positive amount overrides it.`}
            />
            <NumberField
              label="Actual Materials"
              value={actualMaterialCost}
              onChange={setActualMaterialCost}
              hint={job.trackedMaterialCost === undefined
                ? `Estimated: ${fmtMoney(job.materialEstimate || 0)}`
                : `Material log: ${fmtMoney(job.trackedMaterialCost)}. Enter zero to use the log total.`}
            />
          </div>
          <NumberField
            label="Add-on / Misc Costs"
            value={actualAddOnCost}
            onChange={setActualAddOnCost}
            hint="Disposal, repairs, change orders, etc."
          />
          {job.trackedExpenseCost !== undefined && <p className="rounded-md border p-3 text-sm">
            Receipt-backed expenses: <strong>{fmtMoney(job.trackedExpenseCost)}</strong>. Included separately in actual cost. Record manual miscellaneous costs only when they are not already in the expense log.
          </p>}

          <div className="rounded-md border bg-muted/30 p-3 grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-xs text-muted-foreground">Actual Cost</div>
              <div className="font-semibold">{fmtMoney(actualCost)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Gross Profit</div>
              <div
                className={
                  "font-semibold " +
                  (actualProfit >= 0 ? "text-primary" : "text-destructive")
                }
              >
                {showProfit ? fmtMoney(actualProfit) : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Margin</div>
              <div className="font-semibold">
                {showProfit ? `${actualMargin.toFixed(1)}%` : "—"}
              </div>
            </div>
          </div>
          {gaps.length > 0 && <p className="text-xs text-muted-foreground">
            {showProfit ? `Gross profit and margin are provisional pending ${gaps.join(", ")}.` : "Record revenue to calculate gross profit and margin."}
          </p>}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={prefillFromEstimate}
          >
            Prefill from estimate
          </Button>
        </fieldset>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button
            disabled={saving}
            variant="outline"
            onClick={() => close(false)}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save Actuals"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const NumberField = ({
  label,
  value,
  onChange,
  hint,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  hint?: string;
}) => {
  const fieldId = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={fieldId}>{label}</Label>
      <div className="relative">
        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
          $
        </span>
        <Input
          id={fieldId}
          type="number"
          min={0}
          step="0.01"
          className="pl-6"
          value={value === 0 ? "" : value}
          placeholder="0"
          onChange={(e) => onChange(Number(e.target.value) || 0)}
        />
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
};
