import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createVault, seal, unseal } from "./vault.mjs";
import { verifyMailEvent } from "./email.mjs";
test("managed identity audiences refresh independently under concurrent storage and vault requests", async () => {
  const requests = [];
  const vault = createVault(
    { vaultOrigin: "https://fixture.vault.azure.net" },
    {
      IDENTITY_ENDPOINT: "http://127.0.0.1/identity",
      IDENTITY_HEADER: "synthetic-identity",
    },
    async (url) => {
      const resource = new URL(url).searchParams.get("resource");
      requests.push(resource);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({
        access_token: resource,
        expires_on: Math.floor(Date.now() / 1000) + 3600,
      });
    },
  );
  assert.deepEqual(
    await Promise.all([
      vault.access("https://vault.azure.net"),
      vault.access("https://storage.azure.com/"),
      vault.access("https://vault.azure.net"),
    ]),
    [
      "https://vault.azure.net",
      "https://storage.azure.com/",
      "https://vault.azure.net",
    ],
  );
  assert.equal(requests.length, 2);
});

test("HTTP identity cannot read the separately scoped provisioner vault", async () => {
  let requests = 0;
  const config = {
    vaultOrigin: "https://fixture.vault.azure.net",
    provisionerVaultOrigin: "https://workerfixture.vault.azure.net",
  };
  const env = {
    IDENTITY_ENDPOINT: "http://127.0.0.1/identity",
    IDENTITY_HEADER: "synthetic-identity",
  };
  const request = async (url) => {
    requests++;
    return String(url).includes("/identity")
      ? Response.json({
          access_token: "synthetic-token",
          expires_on: Math.floor(Date.now() / 1000) + 3600,
        })
      : Response.json({ value: "synthetic-worker-secret" });
  };
  const httpVault = createVault(config, env, request);
  await assert.rejects(
    httpVault.secret("https://workerfixture.vault.azure.net/secrets/admin"),
    /privileged provisioning/,
  );
  assert.equal(requests, 0);
  const workerVault = createVault(
    { ...config, processRole: "provisioner" },
    env,
    request,
  );
  assert.equal(
    await workerVault.secret(
      "https://workerfixture.vault.azure.net/secrets/admin",
    ),
    "synthetic-worker-secret",
  );
  await assert.rejects(
    workerVault.secret("https://unrelated.vault.azure.net/secrets/admin"),
    /privileged provisioning/,
  );
  await assert.rejects(
    workerVault.put(
      "https://workerfixture.vault.azure.net/secrets/admin",
      "wrong-scope",
    ),
    /approved Key Vault/,
  );
});
test("account email links are authenticated ciphertext and fail after tampering", () => {
  const key = Buffer.alloc(32, 5).toString("base64"),
    sealed = seal({ token: "private" }, key);
  assert.ok(!sealed.includes("private"));
  assert.deepEqual(unseal(sealed, key), { token: "private" });
  const parts = sealed.split("."),
    bytes = Buffer.from(parts[2], "base64url");
  bytes[0] ^= 1;
  parts[2] = bytes.toString("base64url");
  assert.throws(() => unseal(parts.join("."), key));
});
test("email event signatures reject stale timestamps and changed bodies", () => {
  const raw = Buffer.from('{"type":"email.delivered"}'),
    timestamp = String(Math.floor(Date.now() / 1000)),
    secret = "whsec_" + Buffer.alloc(32, 6).toString("base64");
  const signature =
    "v1," +
    createHmac("sha256", Buffer.alloc(32, 6))
      .update(`fixture.${timestamp}.`)
      .update(raw)
      .digest("base64");
  assert.equal(
    verifyMailEvent(raw, "fixture", timestamp, signature, secret),
    true,
  );
  assert.equal(
    verifyMailEvent(Buffer.from("{}"), "fixture", timestamp, signature, secret),
    false,
  );
  assert.equal(
    verifyMailEvent(
      raw,
      "fixture",
      String(Number(timestamp) - 1000),
      signature,
      secret,
    ),
    false,
  );
});
