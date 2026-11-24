import { useState } from "react";
import type { SupplierContact, SupplierContactData } from "@workspace/domain";
import { operation } from "@/lib/operations";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

const blank: SupplierContactData = {
  name: "",
  contactName: "",
  email: "",
  phone: "",
  address: "",
  city: "",
  state: "",
  postalCode: "",
  country: "",
  notes: "",
};
const labels = {
  contactName: "Contact name",
  email: "Email",
  phone: "Phone",
  address: "Address",
  city: "City",
  state: "State / region",
  postalCode: "Postal code",
  country: "Country",
} as const;
export function SupplierContactForm({
  supplier,
  onClose,
  onSaved,
}: {
  supplier?: SupplierContact;
  onClose(): void;
  onSaved(supplier: SupplierContact): void;
}) {
  const [value, setValue] = useState<SupplierContactData>(
      () =>
        Object.fromEntries(
          Object.keys(blank).map((key) => [
            key,
            (supplier ?? blank)[key as keyof SupplierContactData],
          ]),
        ) as unknown as SupplierContactData,
    ),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-auto">
        <DialogHeader>
          <DialogTitle>
            {supplier ? "Edit supplier contacts" : "Add supplier"}
          </DialogTitle>
          <DialogDescription>
            Contact details only. Canonical names, existing purchase labels and
            product mappings are retained. Saving does not send a message.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            const { name, ...contacts } = value;
            void operation<SupplierContact>(
              supplier ? `/suppliers/${supplier.id}` : "/suppliers",
              supplier ? "PATCH" : "POST",
              supplier
                ? { ...contacts, revision: supplier.revision }
                : { ...contacts, name },
            )
              .then(onSaved)
              .catch((failure) =>
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Supplier could not be saved.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          {supplier ? (
            <p>
              Canonical supplier name: <strong>{supplier.name}</strong>
            </p>
          ) : (
            <label className="block text-sm">
              Supplier name
              <Input
                required
                maxLength={200}
                disabled={busy}
                value={value.name}
                onChange={(event) =>
                  setValue({ ...value, name: event.target.value })
                }
              />
            </label>
          )}
          {Object.entries(labels).map(([key, label]) => (
            <label key={key} className="block text-sm">
              {label}
              <Input
                type={key === "email" ? "email" : "text"}
                disabled={busy}
                maxLength={
                  key === "email"
                    ? 320
                    : key === "address"
                      ? 500
                      : key === "postalCode"
                        ? 30
                        : key === "phone"
                          ? 80
                          : 200
                }
                value={value[key as keyof typeof labels]}
                onChange={(event) =>
                  setValue({ ...value, [key]: event.target.value })
                }
              />
            </label>
          ))}
          <label className="block text-sm">
            Notes
            <Textarea
              maxLength={5000}
              disabled={busy}
              value={value.notes}
              onChange={(event) =>
                setValue({ ...value, notes: event.target.value })
              }
            />
          </label>
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          <Button disabled={busy || !value.name.trim()} type="submit">
            {busy ? "Saving…" : "Save supplier"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
export function SupplierActivation({
  supplier,
  onClose,
  onSaved,
}: {
  supplier: SupplierContact;
  onClose(): void;
  onSaved(): void;
}) {
  const [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {supplier.active ? "Deactivate supplier" : "Reactivate supplier"}
          </DialogTitle>
          <DialogDescription>
            {supplier.name}. This changes directory availability only. Existing
            purchase orders, supplier SKU labels, prices and source history
            remain unchanged.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError("");
            void operation(`/suppliers/${supplier.id}/activation`, "POST", {
              revision: supplier.revision,
              active: !supplier.active,
              reason: reason.trim(),
            })
              .then(onSaved)
              .catch((failure) =>
                setError(
                  failure instanceof Error
                    ? failure.message
                    : "Supplier status could not change.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <label className="block">
            Reason
            <Textarea
              required
              minLength={5}
              maxLength={1000}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <Button disabled={busy || reason.trim().length < 5} type="submit">
            Confirm {supplier.active ? "deactivation" : "reactivation"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
