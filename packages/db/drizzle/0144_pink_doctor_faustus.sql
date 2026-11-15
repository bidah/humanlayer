CREATE TABLE "cloud_hosts" (
	"organization_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"host_id" text NOT NULL,
	"provider" text NOT NULL,
	"sandbox_id" text,
	"status" text DEFAULT 'provisioning' NOT NULL,
	"error" text,
	"size" text,
	"ttl_minutes" integer NOT NULL,
	"expires_at" bigint,
	"created_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"updated_at" bigint DEFAULT (extract(epoch from now()) * 1000)::bigint NOT NULL,
	"ready_at" bigint,
	"destroyed_at" bigint,
	"revoked_at" bigint,
	CONSTRAINT "cloud_hosts_pk" PRIMARY KEY("organization_id","user_id","host_id"),
	CONSTRAINT "cloud_hosts_provider_check" CHECK ("cloud_hosts"."provider" in ('cloudflare', 'daytona', 'e2b')),
	CONSTRAINT "cloud_hosts_status_check" CHECK ("cloud_hosts"."status" in ('provisioning', 'bootstrapping', 'ready', 'failed', 'destroying', 'destroyed')),
	CONSTRAINT "cloud_hosts_size_check" CHECK ("cloud_hosts"."size" is null or "cloud_hosts"."size" in ('small', 'medium', 'large'))
);
--> statement-breakpoint
ALTER TABLE "cloud_hosts" ADD CONSTRAINT "cloud_hosts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cloud_hosts_unsettled_created_at_idx" ON "cloud_hosts" USING btree ("created_at") WHERE "cloud_hosts"."status" <> 'destroyed';