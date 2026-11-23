import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { PlatformError, vaultReference } from "./config.mjs";

export function createVault(config, env = process.env, request = fetch) {
  const identityTokens = new Map(),
    refreshing = new Map();
  const values = new Map();
  async function access(resource) {
    if (!env.IDENTITY_ENDPOINT || !env.IDENTITY_HEADER)
      throw new PlatformError(
        503,
        "managed_identity",
        "Azure managed identity is not configured for company provisioning.",
      );
    const cached = identityTokens.get(resource);
    if (cached && cached.expires > Date.now() + 60_000) return cached.value;
    if (refreshing.has(resource)) return refreshing.get(resource);
    const pending = (async () => {
      const url = new URL(env.IDENTITY_ENDPOINT);
      url.searchParams.set("resource", resource);
      url.searchParams.set("api-version", "2019-08-01");
      const response = await request(url, {
        headers: { "X-IDENTITY-HEADER": env.IDENTITY_HEADER },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok)
        throw new PlatformError(
          503,
          "managed_identity",
          "Managed identity authorization is unavailable.",
        );
      const data = await response.json();
      if (
        typeof data.access_token !== "string" ||
        !Number.isFinite(Number(data.expires_on))
      )
        throw new PlatformError(
          503,
          "managed_identity",
          "Managed identity returned an invalid response.",
        );
      identityTokens.set(resource, {
        value: data.access_token,
        expires: Number(data.expires_on) * 1000,
      });
      return data.access_token;
    })().finally(() => {
      refreshing.delete(resource);
    });
    refreshing.set(resource, pending);
    return pending;
  }
  async function secret(ref, optional = false) {
    const origin = new URL(ref).origin;
    if (
      origin !== config.vaultOrigin &&
      (origin !== config.provisionerVaultOrigin ||
        config.processRole !== "provisioner")
    )
      throw new PlatformError(
        503,
        "secret_scope",
        "This process cannot read privileged provisioning credentials.",
      );
    vaultReference(ref, origin);
    const cached = values.get(ref);
    if (cached && cached.until > Date.now()) return cached.value;
    const response = await request(`${ref}?api-version=7.4`, {
      headers: {
        Authorization: `Bearer ${await access("https://vault.azure.net")}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (optional && response.status === 404) return null;
    if (!response.ok)
      throw new PlatformError(
        503,
        "key_vault",
        "The application cannot read its configured Key Vault secrets.",
      );
    const data = await response.json();
    if (typeof data.value !== "string" || !data.value)
      throw new PlatformError(
        503,
        "key_vault",
        "A required Key Vault secret is unavailable.",
      );
    values.set(ref, { value: data.value, until: Date.now() + 300_000 });
    return data.value;
  }
  async function put(ref, value) {
    vaultReference(ref, config.vaultOrigin);
    const response = await request(`${ref}?api-version=7.4`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${await access("https://vault.azure.net")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value, attributes: { enabled: true } }),
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new PlatformError(
        503,
        "key_vault_write",
        "The provisioning worker cannot store company credentials in Key Vault.",
      );
    values.set(ref, { value, until: Date.now() + 300_000 });
  }
  return { secret, put, access };
}
function key(raw) {
  const value = Buffer.from(raw, "base64");
  if (value.length !== 32)
    throw new PlatformError(
      503,
      "encryption",
      "Configure a 32-byte base64 platform encryption key.",
    );
  return value;
}
export function seal(payload, rawKey) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key(rawKey), iv);
  cipher.setAAD(Buffer.from("catalyst-platform-email-v1"));
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), bytes]
    .map((v) => v.toString("base64url"))
    .join(".");
}
export function unseal(value, rawKey) {
  const [iv, tag, bytes] = value
    .split(".")
    .map((v) => Buffer.from(v, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key(rawKey), iv);
  decipher.setAAD(Buffer.from("catalyst-platform-email-v1"));
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([decipher.update(bytes), decipher.final()]).toString("utf8"),
  );
}
