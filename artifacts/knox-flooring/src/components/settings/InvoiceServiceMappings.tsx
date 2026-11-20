import { useEffect, useState } from "react";
import { customFetch } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { InvoiceLineCategory } from "@/lib/types";

export type QuickBooksCatalogItem = { Id: string; Name?: string; Active?: boolean; Type?: string };
export type QuickBooksCatalogItems = { connectionId: string; items: QuickBooksCatalogItem[] };
type Mapping = { category: InvoiceLineCategory; itemId: string | null };
type MappingSettings = { connectionId: string; mappings: Mapping[] };

const categoryLabels: Record<InvoiceLineCategory, string> = {
  Labor: "Labor",
  "Add-on": "Add-ons",
  Materials: "Non-catalog materials",
};
const endpoint = "/api/quickbooks/invoice-service-mappings";

export function InvoiceServiceMappings({ catalog }: { catalog?: QuickBooksCatalogItems }) {
  const [settings, setSettings] = useState<MappingSettings>();
  const [selections, setSelections] = useState<Partial<Record<InvoiceLineCategory, string>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const items = catalog?.connectionId === settings?.connectionId ? catalog?.items : undefined;
  const services = (items ?? []).filter((item) => item.Active === true && item.Type === "Service");
  const serviceNames = new Map(services.map((item) => [item.Id, item.Name || `Item ${item.Id}`]));

  async function load() {
    setError("");
    try {
      setSettings(await customFetch<MappingSettings>(endpoint, { responseType: "json" }));
      setSelections({});
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  }
  useEffect(() => { void load(); }, []);

  async function save(category: InvoiceLineCategory, itemId: string | null) {
    if (!settings || saving) return;
    setSaving(true);
    setError("");
    setFeedback("");
    try {
      const saved = await customFetch<Mapping>(`${endpoint}/${encodeURIComponent(category)}`, {
        method: "PUT",
        body: JSON.stringify({ connectionId: settings.connectionId, itemId }),
        responseType: "json",
      });
      setSettings({ ...settings, mappings: settings.mappings.map((row) => row.category === category ? saved : row) });
      setSelections((values) => ({ ...values, [category]: undefined }));
      setFeedback(itemId ? `${categoryLabels[category]} service item approved.` : `${categoryLabels[category]} service item cleared.`);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Invoice service items</CardTitle>
        <CardDescription>Choose the QuickBooks service items for invoice lines that lack a catalog product.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!items && <p className="text-sm text-muted-foreground">Use Import &amp; reconcile to load service items from this QuickBooks company.</p>}
        {items && services.length === 0 && <p className="text-sm text-muted-foreground">The imported catalog contains no active QuickBooks service items.</p>}
        {settings?.mappings.map(({ category, itemId }, index) => {
          const selected = selections[category] ?? itemId ?? "";
          const label = categoryLabels[category];
          return (
            <div key={category} className="space-y-2 rounded-lg border p-3">
              <Label htmlFor={`invoice-service-item-${index}`}>{label}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  id={`invoice-service-item-${index}`}
                  className="h-9 min-w-44 rounded-md border bg-background px-2 text-sm"
                  value={selected}
                  disabled={saving || services.length === 0}
                  onChange={(event) => setSelections((values) => ({ ...values, [category]: event.target.value }))}
                >
                  <option value="">Choose a service item</option>
                  {itemId && !serviceNames.has(itemId) && <option value={itemId}>Item {itemId} (approved)</option>}
                  {services.map((item) => <option key={item.Id} value={item.Id}>{serviceNames.get(item.Id)} · {item.Id}</option>)}
                </select>
                <Button size="sm" variant="outline" aria-label={`Approve ${label} service item`} disabled={saving || !serviceNames.has(selected) || selected === itemId} onClick={() => void save(category, selected)}>
                  Approve
                </Button>
                {itemId && <Button size="sm" variant="ghost" aria-label={`Clear ${label} service item`} disabled={saving} onClick={() => void save(category, null)}>Clear</Button>}
              </div>
              {itemId && <p className="text-xs text-muted-foreground">Approved {serviceNames.get(itemId) || `item ${itemId}`}</p>}
            </div>
          );
        })}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {(error || (catalog && settings && catalog.connectionId !== settings.connectionId)) && (
          <Button size="sm" variant="outline" onClick={() => void load()}>Reload service mappings</Button>
        )}
        {feedback && <p role="status" className="text-sm text-muted-foreground">{feedback}</p>}
      </CardContent>
    </Card>
  );
}
