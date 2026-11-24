CREATE TABLE "sms_preference_events" (
	"id" text PRIMARY KEY NOT NULL,
	"request_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"recipient" text NOT NULL,
	"kind" text NOT NULL,
	"actor_id" text,
	"binding" jsonb,
	"binding_fingerprint" text,
	"evidence" jsonb,
	"occurred_at" text,
	"recorded_at" text NOT NULL,
	"note" text NOT NULL,
	"synthetic" boolean DEFAULT false NOT NULL,
	"released_suppression" boolean DEFAULT false NOT NULL,
	"provider_message_id" text,
	CONSTRAINT "sms_preference_event_kind_check" CHECK ("sms_preference_events"."kind" IN ('evidence_recorded','suppressed_manual','suppressed_inbound','inbound_start_request','legacy_stop')),
	CONSTRAINT "sms_preference_event_hash_check" CHECK ("sms_preference_events"."request_fingerprint" ~ '^[a-f0-9]{64}$' AND ("sms_preference_events"."binding_fingerprint" IS NULL OR "sms_preference_events"."binding_fingerprint" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "sms_preference_event_binding_check" CHECK (("sms_preference_events"."binding" IS NULL AND "sms_preference_events"."binding_fingerprint" IS NULL) OR ("sms_preference_events"."binding" IS NOT NULL AND "sms_preference_events"."binding_fingerprint" IS NOT NULL AND "sms_preference_events"."binding"->>'fingerprint' = "sms_preference_events"."binding_fingerprint")),
	CONSTRAINT "sms_preference_event_release_check" CHECK (NOT "sms_preference_events"."released_suppression" OR ("sms_preference_events"."kind" = 'evidence_recorded' AND NOT "sms_preference_events"."synthetic" AND "sms_preference_events"."binding_fingerprint" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sms_recipient_preferences" (
	"recipient" text PRIMARY KEY NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"suppressed" boolean DEFAULT false NOT NULL,
	"suppressed_at" text,
	"last_suppression_event_id" text,
	"consent_event_id" text,
	"consent_binding" text,
	"consent_synthetic" boolean DEFAULT false NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "sms_preferences_recipient_check" CHECK ("sms_recipient_preferences"."recipient" ~ '^[+][1-9][0-9]{7,14}$'),
	CONSTRAINT "sms_preferences_revision_check" CHECK ("sms_recipient_preferences"."revision" >= 0),
	CONSTRAINT "sms_preferences_suppression_check" CHECK (NOT "sms_recipient_preferences"."suppressed" OR ("sms_recipient_preferences"."suppressed_at" IS NOT NULL AND "sms_recipient_preferences"."last_suppression_event_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "sms_consent_event_id" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "sms_binding_fingerprint" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "sms_permission_revision" integer;--> statement-breakpoint
ALTER TABLE "sms_preference_events" ADD CONSTRAINT "sms_preference_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_preference_events" ADD CONSTRAINT "sms_events_recipient_fk" FOREIGN KEY ("recipient") REFERENCES "public"."sms_recipient_preferences"("recipient") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_recipient_preferences" ADD CONSTRAINT "sms_preferences_last_event_fk" FOREIGN KEY ("last_suppression_event_id") REFERENCES "public"."sms_preference_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_recipient_preferences" ADD CONSTRAINT "sms_preferences_consent_event_fk" FOREIGN KEY ("consent_event_id") REFERENCES "public"."sms_preference_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sms_preference_event_request_unique" ON "sms_preference_events" USING btree ("request_key");--> statement-breakpoint
CREATE INDEX "sms_preference_event_recipient_idx" ON "sms_preference_events" USING btree ("recipient","recorded_at");--> statement-breakpoint
CREATE INDEX "sms_preference_event_actor_idx" ON "sms_preference_events" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "sms_preferences_consent_event_idx" ON "sms_recipient_preferences" USING btree ("consent_event_id");--> statement-breakpoint
CREATE INDEX "sms_preferences_suppression_event_idx" ON "sms_recipient_preferences" USING btree ("last_suppression_event_id");--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_sms_consent_event_id_sms_preference_events_id_fk" FOREIGN KEY ("sms_consent_event_id") REFERENCES "public"."sms_preference_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communications_sms_stop_recipient_idx" ON "communications" USING btree ("from_address","created_at") WHERE "communications"."channel" = 'sms' AND "communications"."direction" = 'inbound' AND "communications"."status" = 'received' AND "communications"."provider_message_id" LIKE 'signalwire:%' AND "communications"."subject" IN ('SMS opt-out','SMS opt-out pending provider timestamp');--> statement-breakpoint
CREATE INDEX "communications_sms_consent_event_idx" ON "communications" USING btree ("sms_consent_event_id");--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_sms_permission_check" CHECK (("communications"."sms_consent_event_id" IS NULL AND "communications"."sms_binding_fingerprint" IS NULL AND "communications"."sms_permission_revision" IS NULL) OR ("communications"."channel" = 'sms' AND "communications"."sms_consent_event_id" IS NOT NULL AND "communications"."sms_binding_fingerprint" ~ '^[a-f0-9]{64}$' AND "communications"."sms_permission_revision" > 0));
--> statement-breakpoint
-- Preserve existing signed STOP evidence conservatively. Historical START rows
-- do not manufacture initial permission or erase an office review requirement.
-- Existing communications, stock, financial rows and provider queues are untouched.
INSERT INTO sms_recipient_preferences(recipient,updated_at)
SELECT DISTINCT from_address, max(created_at) OVER (PARTITION BY from_address)
FROM communications WHERE channel='sms' AND direction='inbound' AND status='received'
  AND provider_message_id LIKE 'signalwire:%'
  AND subject IN ('SMS opt-out','SMS opt-out pending provider timestamp')
  AND from_address ~ '^[+][1-9][0-9]{7,14}$'
ON CONFLICT(recipient) DO NOTHING;
--> statement-breakpoint
INSERT INTO sms_preference_events(id,request_key,request_fingerprint,recipient,kind,recorded_at,occurred_at,note,provider_message_id)
SELECT 'legacy-stop:'||id,'inbound:'||provider_message_id,
  encode(sha256(convert_to('legacy-stop:'||id,'UTF8')),'hex'),from_address,'legacy_stop',created_at,
  CASE WHEN subject='SMS opt-out' THEN created_at ELSE NULL END,
  'Retained existing signed STOP evidence; owner review is required. No positive permission was inferred.',provider_message_id
FROM communications WHERE channel='sms' AND direction='inbound' AND status='received'
  AND provider_message_id LIKE 'signalwire:%'
  AND subject IN ('SMS opt-out','SMS opt-out pending provider timestamp')
  AND from_address ~ '^[+][1-9][0-9]{7,14}$'
ON CONFLICT(request_key) DO NOTHING;
--> statement-breakpoint
UPDATE sms_recipient_preferences p SET revision=1,suppressed=true,suppressed_at=e.recorded_at,
  last_suppression_event_id=e.id,updated_at=e.recorded_at
FROM (SELECT DISTINCT ON(recipient) id,recipient,recorded_at FROM sms_preference_events
      WHERE kind='legacy_stop' ORDER BY recipient,recorded_at DESC,id DESC) e
WHERE p.recipient=e.recipient;
--> statement-breakpoint
CREATE FUNCTION catalyst_sms_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SMS preference evidence is immutable; append a new reviewed event.' USING ERRCODE='23514'; END $$;
--> statement-breakpoint
CREATE TRIGGER sms_preference_event_immutable BEFORE UPDATE OR DELETE ON sms_preference_events
FOR EACH ROW EXECUTE FUNCTION catalyst_sms_event_immutable();
--> statement-breakpoint
CREATE FUNCTION catalyst_sms_preference_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE evidence sms_preference_events%ROWTYPE; negative sms_preference_events%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.recipient<>OLD.recipient OR NEW.revision<>OLD.revision+1 THEN
      RAISE EXCEPTION 'SMS preference recipient and revision guard failed.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF NEW.consent_event_id IS NOT NULL THEN
    SELECT * INTO evidence FROM sms_preference_events WHERE id=NEW.consent_event_id;
    IF NOT FOUND OR evidence.recipient<>NEW.recipient OR evidence.kind<>'evidence_recorded'
       OR evidence.actor_id IS NULL OR evidence.occurred_at IS NULL
       OR evidence.binding_fingerprint IS DISTINCT FROM NEW.consent_binding
       OR evidence.synthetic IS DISTINCT FROM NEW.consent_synthetic THEN
      RAISE EXCEPTION 'SMS positive permission must reference matching owner evidence.' USING ERRCODE='23514';
    END IF;
  ELSIF NEW.consent_binding IS NOT NULL THEN
    RAISE EXCEPTION 'SMS permission binding requires its evidence.' USING ERRCODE='23514';
  END IF;
  IF NEW.suppressed THEN
    SELECT * INTO negative FROM sms_preference_events WHERE id=NEW.last_suppression_event_id;
    IF NOT FOUND OR negative.recipient<>NEW.recipient
       OR negative.kind NOT IN ('suppressed_manual','suppressed_inbound','legacy_stop')
       OR negative.recorded_at IS DISTINCT FROM NEW.suppressed_at THEN
      RAISE EXCEPTION 'SMS suppression requires matching retained evidence.' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='UPDATE' AND OLD.suppressed AND NOT NEW.suppressed THEN
    IF NEW.consent_event_id IS NOT DISTINCT FROM OLD.consent_event_id
       OR NOT evidence.released_suppression OR evidence.synthetic
       OR evidence.binding_fingerprint IS NULL
       OR evidence.occurred_at::timestamptz <= OLD.suppressed_at::timestamptz THEN
      RAISE EXCEPTION 'SMS opt-out requires explicit owner review of renewed evidence.' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER sms_preference_state_guard BEFORE INSERT OR UPDATE ON sms_recipient_preferences
FOR EACH ROW EXECUTE FUNCTION catalyst_sms_preference_guard();
