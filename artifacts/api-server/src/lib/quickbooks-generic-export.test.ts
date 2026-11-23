import { describe, expect, it, vi } from "vitest";
import {
  assertGenericExportCompany,
  GenericExportReviewRequired,
  prepareGenericExport,
  reconcileGenericExport,
} from "./quickbooks-generic-export";

const company = {
  id: "connection-1",
  realmId: "123",
  environment: "sandbox",
  status: "connected",
};
function fixture(entity: "customer" | "estimate" = "customer") {
  const document =
    entity === "customer"
      ? {
          DisplayName: "Internal customer",
          PrimaryEmailAddr: { Address: "owner@example.test" },
        }
      : {
          CustomerRef: { value: "77" },
          Line: [
            {
              Amount: 48,
              DetailType: "SalesItemLineDetail",
              SalesItemLineDetail: {
                Qty: 1,
                UnitPrice: 48,
                ItemRef: { value: "12" },
              },
            },
          ],
        };
  return prepareGenericExport("queue-1", entity, "local-1", company, document);
}
describe("durable generic QuickBooks exports", () => {
  it("requires custom transaction numbers before claiming or submitting a new estimate", async () => {
    const request = vi.fn(async () => ({
      Preferences: { SalesFormsPrefs: { CustomTxnNumbers: false } },
    }));
    const claim = vi.fn();
    await expect(
      reconcileGenericExport(
        fixture("estimate"),
        { request, query: async () => ({ QueryResponse: {} }) },
        claim,
        vi.fn(),
      ),
    ).rejects.toThrow(/Enable custom transaction numbers/);
    expect(claim).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledExactlyOnceWith("/preferences");
  });
  it("updates only the originally approved record and refuses a stale remote revision", async () => {
    const attempt = prepareGenericExport(
      "update-q",
      "customer",
      "local",
      company,
      { Id: "7", SyncToken: "1", sparse: true, DisplayName: "Approved update" },
    );
    const provider = {
      query: vi.fn(),
      request: vi.fn(async (_path: string, init?: RequestInit) =>
        init?.method === "POST"
          ? {
              Customer: {
                Id: "7",
                SyncToken: "2",
                DisplayName: "Approved update",
              },
            }
          : {
              Customer: {
                Id: "7",
                SyncToken: "1",
                DisplayName: "Previous name",
              },
            },
      ),
    };
    await reconcileGenericExport(
      attempt,
      provider,
      async () => {},
      async () => {},
    );
    expect(provider.request.mock.calls[1][1]?.body).toBe(
      JSON.stringify(attempt.document),
    );
    provider.request.mockReset();
    provider.request.mockResolvedValue({
      Customer: { Id: "7", SyncToken: "3", DisplayName: "External edit" },
    });
    await expect(
      reconcileGenericExport(attempt, provider, vi.fn(), vi.fn()),
    ).rejects.toThrow(/changed after approval/);
    expect(provider.request).toHaveBeenCalledTimes(1);
  });
  it("does not treat provider omission of blank optional address fields as an unconfirmed create", async () => {
    const attempt = prepareGenericExport(
      "q-blank",
      "customer",
      "local",
      company,
      { DisplayName: "Internal customer", BillAddr: { Line1: "", City: "" } },
    );
    const confirm = vi.fn(async () => {});
    await reconcileGenericExport(
      attempt,
      {
        query: async () => ({ QueryResponse: {} }),
        request: async () => ({
          Customer: {
            Id: "8",
            DisplayName: "Internal customer",
            Notes: attempt.document.Notes,
          },
        }),
      },
      async () => {},
      confirm,
    );
    expect(confirm).toHaveBeenCalledOnce();
  });
  it.each(["customer", "estimate"] as const)(
    "freezes %s documents and submits a company-scoped request ID after the durable claim",
    async (entity) => {
      const attempt = fixture(entity);
      const sequence: string[] = [];
      const key = entity === "customer" ? "Customer" : "Estimate";
      const provider = {
        query: vi.fn(async () => ({ QueryResponse: {} })),
        request: vi.fn(async (path, init) => {
          if (path === "/preferences")
            return {
              Preferences: { SalesFormsPrefs: { CustomTxnNumbers: true } },
            };
          expect(path).toBe(`/${entity}?requestid=${attempt.requestId}`);
          sequence.push("post");
          return {
            [key]: {
              ...JSON.parse(init!.body as string),
              Id: "42",
              SyncToken: "0",
            },
          };
        }),
      };
      await reconcileGenericExport(
        attempt,
        provider,
        async () => {
          sequence.push("claim");
        },
        async () => {
          sequence.push("confirm");
        },
      );
      expect(sequence).toEqual(["claim", "post", "confirm"]);
      expect(attempt.requestId).toMatch(/^[a-z0-9-]{50}$/);
      expect(
        prepareGenericExport(
          "queue-2",
          entity,
          "local-1",
          company,
          attempt.document,
        ).requestId,
      ).not.toBe(attempt.requestId);
      expect(
        prepareGenericExport(
          "queue-1",
          entity,
          "local-1",
          { ...company, realmId: "456" },
          attempt.document,
        ).requestId,
      ).not.toBe(attempt.requestId);
    },
  );
  it("does not let later source edits change the approved snapshot", async () => {
    const source = { DisplayName: "Approved name" };
    const attempt = prepareGenericExport("q", "customer", "l", company, source);
    source.DisplayName = "Edited after approval";
    const request = vi.fn(async (_path, init) => ({
      Customer: { ...JSON.parse(init!.body as string), Id: "4" },
    }));
    await reconcileGenericExport(
      attempt,
      { request, query: async () => ({ QueryResponse: {} }) },
      async () => {},
      async () => {},
    );
    expect(
      JSON.parse(request.mock.calls[0][1]!.body as string).DisplayName,
    ).toBe("Approved name");
  });
  it("reconciles a provider success lost to a network timeout without another POST", async () => {
    const attempt = fixture("estimate");
    let saved = attempt;
    let remote: unknown;
    const request = vi.fn(async (_path, init) => {
      if (_path === "/preferences")
        return { Preferences: { SalesFormsPrefs: { CustomTxnNumbers: true } } };
      remote = { ...JSON.parse(init!.body as string), Id: "42" };
      throw new Error("network timeout after commit");
    });
    const provider = {
      request,
      query: vi.fn(async () => ({
        QueryResponse: remote ? { Estimate: [remote] } : {},
      })),
    };
    await expect(
      reconcileGenericExport(
        attempt,
        provider,
        async () => {
          saved = { ...attempt, state: "submitting" };
        },
        async () => {},
      ),
    ).rejects.toBeInstanceOf(GenericExportReviewRequired);
    const confirm = vi.fn(async () => {});
    await reconcileGenericExport(
      saved,
      provider,
      async () => {
        throw new Error("must not resubmit");
      },
      confirm,
    );
    expect(
      request.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(confirm).toHaveBeenCalledExactlyOnceWith(remote);
  });
  it("stops an unconfirmed prior write even when the provider lookup is temporarily empty", async () => {
    const provider = {
      query: async () => ({ QueryResponse: {} }),
      request: vi.fn(),
    };
    await expect(
      reconcileGenericExport(
        { ...fixture(), state: "submitting" },
        provider,
        vi.fn(),
        vi.fn(),
      ),
    ).rejects.toThrow(/not resubmitted/);
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("recovers a crash after POST but before mapping persistence without another POST", async () => {
    const attempt = fixture();
    let remote: unknown;
    let saved = attempt;
    const provider = {
      query: async () => ({
        QueryResponse: remote ? { Customer: [remote] } : {},
      }),
      request: vi.fn(async (_path, init) => ({
        Customer: (remote = {
          ...JSON.parse(init!.body as string),
          Id: "9",
          SyncToken: "1",
        }),
      })),
    };
    await expect(
      reconcileGenericExport(
        attempt,
        provider,
        async () => {
          saved = { ...attempt, state: "submitting" };
        },
        async () => {
          throw new Error("persistence interruption");
        },
      ),
    ).rejects.toThrow(/persistence interruption/);
    const confirm = vi.fn(async () => {});
    await reconcileGenericExport(saved, provider, vi.fn(), confirm);
    expect(provider.request).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledOnce();
  });
  it("refuses a connection/company change and conflicting remote records", async () => {
    const attempt = fixture();
    for (const changed of [
      { id: "other" },
      { realmId: "456" },
      { environment: "production" },
      { status: "disconnected" },
    ])
      expect(() =>
        assertGenericExportCompany(attempt, { ...company, ...changed }),
      ).toThrow(/connection changed/);
    const provider = {
      query: async () => ({
        QueryResponse: {
          Customer: [
            {
              Id: "9",
              DisplayName: "Internal customer",
              Notes: "someone else",
            },
          ],
        },
      }),
      request: vi.fn(),
    };
    await expect(
      reconcileGenericExport(attempt, provider, vi.fn(), vi.fn()),
    ).rejects.toThrow(/different QuickBooks record/);
    expect(provider.request).not.toHaveBeenCalled();
  });
  it("does not POST when the durable claim cannot be persisted", async () => {
    const provider = {
      query: async () => ({ QueryResponse: {} }),
      request: vi.fn(),
    };
    await expect(
      reconcileGenericExport(
        fixture(),
        provider,
        async () => {
          throw new Error("claim refused");
        },
        vi.fn(),
      ),
    ).rejects.toThrow(/claim refused/);
    expect(provider.request).not.toHaveBeenCalled();
  });
});
