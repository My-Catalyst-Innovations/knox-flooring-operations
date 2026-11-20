import { describe, expect, it, vi } from "vitest";
import { loadQuickBooksCatalogEntity } from "./quickbooks-catalog";

describe("QuickBooks catalog pagination", () => {
  it("reads past the 1,000-item cap, keeping unique string IDs and inactive rows", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({
      Id: `first-${i}`,
    }));
    const second = Array.from({ length: 301 }, (_, i) => ({
      Id: i === 0 ? "first-999" : `second-${i}`,
      Active: false,
    }));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ QueryResponse: { Item: first } })
      .mockResolvedValueOnce({ QueryResponse: { Item: second } });

    const rows = await loadQuickBooksCatalogEntity("Item", query);
    expect(rows).toHaveLength(1300);
    expect(rows[1299]).toEqual({ Id: "second-300", Active: false });
    expect(query.mock.calls).toEqual([
      [
        "select * from Item where Active IN (true, false) orderby Name startposition 1 maxresults 1000",
      ],
      [
        "select * from Item where Active IN (true, false) orderby Name startposition 1001 maxresults 1000",
      ],
    ]);
  });

  it("treats an empty query response as the end after a full page", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i) }));
    const query = vi
      .fn()
      .mockResolvedValueOnce({ QueryResponse: { Vendor: first } })
      .mockResolvedValueOnce({ QueryResponse: {} });
    await expect(loadQuickBooksCatalogEntity("Vendor", query)).resolves.toEqual(
      first,
    );
  });

  it("rejects a page that repeats entirely or lacks record IDs", async () => {
    const first = Array.from({ length: 1000 }, (_, i) => ({ Id: String(i) }));
    const query = vi.fn().mockResolvedValue({ QueryResponse: { Item: first } });
    await expect(loadQuickBooksCatalogEntity("Item", query)).rejects.toThrow(
      "repeated a catalog page",
    );
    await expect(
      loadQuickBooksCatalogEntity("Item", async () => ({
        QueryResponse: { Item: [{ Id: "" }] },
      })),
    ).rejects.toThrow("invalid catalog page");
  });
});
