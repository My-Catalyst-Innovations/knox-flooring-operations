CREATE TABLE platform_accounts (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, name text NOT NULL,
  verified_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_tokens (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform_accounts(id),
  token_hash text NOT NULL UNIQUE, purpose text NOT NULL CHECK (purpose IN ('verify','login','email_change')), context jsonb NOT NULL DEFAULT '{}',
  expires_at timestamptz NOT NULL, used_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_sessions (
  id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES platform_accounts(id),
  token_hash text NOT NULL UNIQUE, csrf_token text NOT NULL, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_organizations (
  id uuid PRIMARY KEY, owner_account_id uuid NOT NULL REFERENCES platform_accounts(id),
  slug text NOT NULL UNIQUE, company_name text NOT NULL, profile jsonb NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'pending_payment' CHECK (state IN ('pending_payment','provisioning','owner_pending','ready','blocked','failed')),
  stripe_customer_id text UNIQUE, stripe_subscription_id text UNIQUE, subscription_status text,
  subscription_price_id text, subscription_ends_at timestamptz,
  entitlement text NOT NULL DEFAULT 'none' CHECK (entitlement IN ('none','paid','trial','grandfathered','risk_review')),
  last_billing_sync timestamptz, revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_memberships (
  organization_id uuid NOT NULL REFERENCES platform_organizations(id), account_id uuid NOT NULL REFERENCES platform_accounts(id),
  role text NOT NULL CHECK (role IN ('owner','billing_admin')), PRIMARY KEY (organization_id,account_id)
);
CREATE TABLE platform_checkout_attempts (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES platform_organizations(id),
  price_id text NOT NULL, contract jsonb NOT NULL, customer_request jsonb NOT NULL, request_payload jsonb, session_id text UNIQUE, url text, state text NOT NULL DEFAULT 'creating',
  expires_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX platform_one_open_checkout ON platform_checkout_attempts(organization_id) WHERE state IN ('creating','open','payment_pending');
CREATE TABLE platform_billing_events (
  id text PRIMARY KEY, event_type text NOT NULL, livemode boolean NOT NULL,
  resource jsonb NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz, lease_token uuid, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz
);
CREATE TABLE platform_risk_reviews (
  id uuid PRIMARY KEY, organization_id uuid REFERENCES platform_organizations(id),
  event_id text NOT NULL UNIQUE REFERENCES platform_billing_events(id), reason text NOT NULL,
  resource jsonb NOT NULL, status text NOT NULL DEFAULT 'open', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_tenants (
  organization_id uuid PRIMARY KEY REFERENCES platform_organizations(id), workspace_key text NOT NULL UNIQUE,
  origin text NOT NULL UNIQUE, database_secret_ref text NOT NULL, container text NOT NULL UNIQUE,
  configuration jsonb NOT NULL DEFAULT '{}', owner_activated_at timestamptz, dns_tls_verified_at timestamptz,
  ready_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_provisioning_jobs (
  organization_id uuid PRIMARY KEY REFERENCES platform_organizations(id), step text NOT NULL DEFAULT 'allocate',
  attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz, lease_token uuid,
  error_code text, resources jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE platform_email_outbox (
  id uuid PRIMARY KEY, account_id uuid REFERENCES platform_accounts(id), purpose text NOT NULL,
  encrypted_payload text NOT NULL, recipient_hash text NOT NULL, state text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
  provider_id text, expires_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT now(), locked_until timestamptz, lease_token uuid, error_code text,
  created_at timestamptz NOT NULL DEFAULT now(), submitted_at timestamptz
);
CREATE TABLE platform_audit (
  id uuid PRIMARY KEY, organization_id uuid REFERENCES platform_organizations(id), account_id uuid REFERENCES platform_accounts(id),
  action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_email_due ON platform_email_outbox(state,next_attempt_at);
CREATE INDEX platform_event_due ON platform_billing_events(state,next_attempt_at);
CREATE INDEX platform_job_due ON platform_provisioning_jobs(next_attempt_at);
CREATE TABLE platform_rate_limits (key text PRIMARY KEY, used integer NOT NULL DEFAULT 1, expires_at timestamptz NOT NULL);
CREATE TABLE platform_email_events (id text PRIMARY KEY, event_type text NOT NULL, provider_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE platform_email_suppressions (recipient_hash text PRIMARY KEY, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
