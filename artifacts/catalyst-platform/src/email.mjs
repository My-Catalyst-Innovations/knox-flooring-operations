import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { PlatformError, hash, token, validEmail } from "./config.mjs";
import { seal, unseal } from "./vault.mjs";

export function verifyMailEvent(
  raw,
  id,
  timestamp,
  signatures,
  secret,
  now = Date.now(),
) {
  if (
    !Buffer.isBuffer(raw) ||
    !id ||
    !/^\d+$/.test(timestamp ?? "") ||
    Math.abs(now / 1000 - Number(timestamp)) > 300 ||
    !secret?.startsWith("whsec_")
  )
    return false;
  const key = Buffer.from(secret.slice(6), "base64");
  if (key.length < 16) return false;
  const expected = createHmac("sha256", key)
    .update(`${id}.${timestamp}.`)
    .update(raw)
    .digest();
  return String(signatures ?? "")
    .split(" ")
    .some((part) => {
      if (!part.startsWith("v1,")) return false;
      const actual = Buffer.from(part.slice(3), "base64");
      return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
      );
    });
}
export function createPlatformMail({ config, vault, store, request = fetch }) {
  async function enqueue(
    writer,
    accountId,
    to,
    subject,
    text,
    purpose,
    expiresAt = null,
  ) {
    if (!validEmail(to) || !config.emailEnabled || !config.refs.encryption)
      throw new PlatformError(
        503,
        "email",
        "Account email delivery is unavailable.",
      );
    const suppressed = (
      await writer.query(
        "SELECT recipient_hash FROM platform_email_suppressions WHERE recipient_hash=$1",
        [hash(to.toLowerCase())],
      )
    ).rows[0];
    if (suppressed)
      throw new PlatformError(
        409,
        "email_suppressed",
        "This address cannot receive account emails. Contact support through another channel.",
      );
    const id = randomUUID(),
      payload = seal(
        { to, subject, text },
        await vault.secret(config.refs.encryption),
      );
    await writer.query(
      "INSERT INTO platform_email_outbox(id,account_id,purpose,encrypted_payload,recipient_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
      [id, accountId, purpose, payload, hash(to.toLowerCase()), expiresAt],
    );
    return id;
  }
  async function accountLink(
    account,
    purpose,
    context = {},
    writer = store.pool,
  ) {
    const raw = token(),
      id = randomUUID();
    await writer.query(
      "INSERT INTO platform_tokens(id,account_id,token_hash,purpose,context,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '30 minutes')",
      [id, account.id, hash(raw), purpose, context],
    );
    const address = purpose === "email_change" ? context.email : account.email;
    const subject =
      purpose === "verify"
        ? "Verify your email for Catalyst Works"
        : purpose === "email_change"
          ? "Confirm your new Catalyst Works email"
          : "Sign in to Catalyst Works billing";
    await enqueue(
      writer,
      account.id,
      address,
      subject,
      `${subject}.\n\nOpen ${config.origin}/account/verify#token=${raw}\n\nConfirm the request on that page. This link expires in 30 minutes and can be used once. If you did not request it, ignore this email.`,
      purpose,
      new Date(Date.now() + 30 * 60_000).toISOString(),
    );
  }
  async function send(row) {
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())
      throw new PlatformError(
        409,
        "email_expired",
        "This account link expired before delivery. Request a new link.",
      );
    if (Date.now() - new Date(row.created_at).getTime() > 20 * 3600_000)
      throw new PlatformError(
        409,
        "email_unconfirmed",
        "This email needs a fresh request after its submission window.",
      );
    const message = unseal(
      row.encrypted_payload,
      await vault.secret(config.refs.encryption),
    );
    if (hash(message.to.toLowerCase()) !== row.recipient_hash)
      throw new PlatformError(
        409,
        "email_integrity",
        "Account email could not be verified.",
      );
    if (
      (
        await store.query(
          "SELECT recipient_hash FROM platform_email_suppressions WHERE recipient_hash=$1",
          [row.recipient_hash],
        )
      ).rows[0]
    )
      throw new PlatformError(
        409,
        "email_suppressed",
        "Email recipient is suppressed.",
      );
    const signing = await vault.secret(config.refs.emailWebhook),
      proof = createHmac("sha256", signing).update(row.id).digest("hex");
    const response = await request("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${await vault.secret(config.refs.resend)}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `cw-platform-${row.id}`,
      },
      body: JSON.stringify({
        from: config.fromEmail,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        tags: [
          { name: "platform_outbox", value: row.id },
          { name: "platform_proof", value: proof },
        ],
      }),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok)
      throw new PlatformError(
        response.status === 429 || response.status >= 500 ? 503 : 409,
        "email_provider",
        "The account email provider rejected this request.",
      );
    const result = await response.json();
    if (typeof result.id !== "string")
      throw new PlatformError(
        503,
        "email_unconfirmed",
        "The account email submission was not confirmed.",
      );
    await store.query(
      "UPDATE platform_email_outbox SET state=CASE WHEN state='processing' THEN 'submitted' ELSE state END,provider_id=$3,submitted_at=COALESCE(submitted_at,now()),locked_until=NULL WHERE id=$1 AND lease_token=$2",
      [row.id, row.lease_token, result.id],
    );
  }
  async function webhook(raw, headers) {
    const secret = await vault.secret(config.refs.emailWebhook);
    if (
      !verifyMailEvent(
        raw,
        headers.id,
        headers.timestamp,
        headers.signature,
        secret,
      )
    )
      throw new PlatformError(
        401,
        "signature",
        "Invalid account email event signature.",
      );
    let event;
    try {
      event = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new PlatformError(
        400,
        "email_event",
        "Invalid account email event.",
      );
    }
    if (
      ![
        "email.sent",
        "email.delivered",
        "email.failed",
        "email.bounced",
        "email.complained",
        "email.suppressed",
      ].includes(event.type)
    )
      return;
    const data = event.data,
      recipient =
        Array.isArray(data?.to) && data.to.length === 1
          ? data.to[0]?.toLowerCase()
          : null;
    if (!validEmail(recipient) || typeof data.email_id !== "string")
      throw new PlatformError(
        400,
        "email_event",
        "Invalid account email event.",
      );
    await store.transaction(async (writer) => {
      const tags = data.tags ?? {},
        outboxId = tags.platform_outbox,
        proof = tags.platform_proof;
      const validProof =
        typeof outboxId === "string" &&
        typeof proof === "string" &&
        /^[a-f0-9]{64}$/.test(proof) &&
        timingSafeEqual(
          Buffer.from(proof, "hex"),
          createHmac("sha256", secret).update(outboxId).digest(),
        );
      const row = (
        await writer.query(
          "SELECT * FROM platform_email_outbox WHERE recipient_hash=$1 AND (provider_id=$2 OR id::text=$3) FOR UPDATE",
          [hash(recipient), data.email_id, validProof ? outboxId : ""],
        )
      ).rows[0];
      if (!row || (row.provider_id && row.provider_id !== data.email_id))
        return;
      const inserted = await writer.query(
        "INSERT INTO platform_email_events(id,event_type,provider_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING id",
        [headers.id, event.type, data.email_id],
      );
      if (!inserted.rows.length) return;
      const suppression =
        ["email.complained", "email.suppressed"].includes(event.type) ||
        (event.type === "email.bounced" && data.bounce?.type === "Permanent");
      if (suppression)
        await writer.query(
          "INSERT INTO platform_email_suppressions(recipient_hash,reason) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [hash(recipient), event.type],
        );
      const failed =
        suppression || ["email.failed", "email.bounced"].includes(event.type);
      const state = failed
        ? "failed"
        : event.type === "email.delivered"
          ? "delivered"
          : row.state === "delivered" || row.state === "failed"
            ? row.state
            : "sent";
      await writer.query(
        "UPDATE platform_email_outbox SET provider_id=$2,state=$3,error_code=$4 WHERE id=$1",
        [row.id, data.email_id, state, failed ? event.type : null],
      );
    });
  }
  return { enqueue, accountLink, send, webhook };
}
