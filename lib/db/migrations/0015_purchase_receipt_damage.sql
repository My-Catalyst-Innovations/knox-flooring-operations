ALTER TABLE "purchase_receipt_lines" DROP CONSTRAINT "purchase_receipt_lines_quantity_valid";--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ALTER COLUMN "movement_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD COLUMN "damaged_quantity" numeric(18, 6) DEFAULT '0' NOT NULL;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD COLUMN "damage_note" text;--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_stock_link_valid" CHECK (("purchase_receipt_lines"."quantity" > 0) = ("purchase_receipt_lines"."movement_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_damage_note_valid" CHECK ("purchase_receipt_lines"."damage_note" IS NULL OR ("purchase_receipt_lines"."damaged_quantity" > 0 AND char_length("purchase_receipt_lines"."damage_note") <= 240));--> statement-breakpoint
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_quantity_valid" CHECK ("purchase_receipt_lines"."quantity" >= 0 AND "purchase_receipt_lines"."quantity" < 'Infinity'::numeric
        AND "purchase_receipt_lines"."damaged_quantity" >= 0 AND "purchase_receipt_lines"."damaged_quantity" < 'Infinity'::numeric
        AND "purchase_receipt_lines"."quantity" + "purchase_receipt_lines"."damaged_quantity" > 0);