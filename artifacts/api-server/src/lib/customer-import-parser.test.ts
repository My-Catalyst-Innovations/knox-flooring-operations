import { expect, it } from "vitest";
import {
  customerImportMatches,
  inspectCustomerCsv,
  mapCustomerCsv,
} from "@workspace/domain";
const mapping = { sourceId: "ID", name: "Name", email: "Email" };
it("preserves leading-zero source IDs and parses quoted contact fields", () => {
  const result = mapCustomerCsv(
    'ID,Name,Email\r\n00001,"Fictional, Household",sample@example.invalid',
    mapping,
  );
  expect(result.rows[0]).toMatchObject({
    line: 2,
    data: { sourceId: "00001", name: "Fictional, Household" },
    errors: [],
  });
});
it("supports explicit tab mapping without importing unmapped financial columns", () => {
  const result = mapCustomerCsv(
    "ID\tName\tEmail\tBalance\n0001\tFictional Household\t\t99999",
    mapping,
    "\t",
  );
  expect(result.rows[0].data).not.toHaveProperty("Balance");
  expect(result.rows[0].data.sourceId).toBe("0001");
});
it.each(["ID,Name,Name\n1,A,B", "ID,Name\n1", 'ID,Name\n1,"Unclosed'])(
  "rejects malformed or ambiguous CSV %s",
  (csv) => expect(() => inspectCustomerCsv(csv)).toThrow(),
);
it("bounds both UTF-8 bytes and row count", () => {
  expect(() => inspectCustomerCsv("ID,Name\n1," + "😀".repeat(50001))).toThrow(
    "200 KB",
  );
  expect(() =>
    inspectCustomerCsv(
      "ID,Name\n" +
        Array.from({ length: 201 }, (_, index) => `${index},Fictional`).join(
          "\n",
        ),
    ),
  ).toThrow("1–200");
});
it("requires explicit existing distinct mapped columns", () => {
  expect(() =>
    mapCustomerCsv("ID,Name\n1,Fictional", { name: "Name" }),
  ).toThrow("Map");
  expect(() =>
    mapCustomerCsv("ID,Name\n1,Fictional", { sourceId: "ID", name: "Missing" }),
  ).toThrow("existing");
  expect(() =>
    mapCustomerCsv("ID,Name\n1,Fictional", { sourceId: "Name", name: "Name" }),
  ).toThrow("once");
});
it("flags reused source IDs and possible duplicate rows without choosing an action", () => {
  const rows = mapCustomerCsv(
    "ID,Name,Email\n0001,Fictional,same@example.invalid\n0001,Other,same@example.invalid",
    mapping,
  ).rows;
  expect(
    rows.every((row) =>
      row.errors.some((error) => error.includes("more than once")),
    ),
  ).toBe(true);
  expect(rows[0].fileDuplicates).toEqual([3]);
  expect(rows[0]).not.toHaveProperty("action");
});
it("flags invalid contacts for explicit correction or skipping", () => {
  expect(
    mapCustomerCsv("ID,Name,Email\n1,Fictional,not-email", mapping).rows[0]
      .errors,
  ).toContain("Correct the email address or skip this row.");
});
it("compares exact normalized names, emails and US phone identities", () => {
  const data = mapCustomerCsv(
    "ID,Name,Email\n1, Fictional   Household ,sample@example.invalid",
    mapping,
  ).rows[0].data;
  expect(
    customerImportMatches(data, {
      id: "candidate",
      name: "fictional household",
      email: "",
      phone: "",
      revision: 1,
      updatedAt: "",
      mergedIntoId: null,
    }),
  ).toBe(true);
  expect(
    customerImportMatches(
      { ...data, name: "Other", email: "", phone: "+1 (865) 555-0123" },
      {
        id: "candidate",
        name: "Different",
        email: "",
        phone: "865-555-0123",
        revision: 1,
        updatedAt: "",
        mergedIntoId: null,
      },
    ),
  ).toBe(true);
});
