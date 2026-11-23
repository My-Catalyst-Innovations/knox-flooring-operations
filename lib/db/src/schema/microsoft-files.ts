import { sql } from "drizzle-orm";
import { check, index, integer, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

export const microsoftFilesConnectionTable = pgTable("microsoft_files_connection", {
  id: integer("id").primaryKey().default(1), accountId: text("account_id").notNull(), accountEmail: text("account_email").notNull(),
  clientId: text("client_id").notNull(), grantedScopes: text("granted_scopes").notNull(), status: text("status").notNull(),
  accessToken: text("access_token"), refreshToken: text("refresh_token"), expiresAt: text("expires_at"),
  driveId: text("drive_id"), folderId: text("folder_id"), folderName: text("folder_name"), folderWebUrl: text("folder_web_url"), verifiedAt: text("verified_at"),
  updatedAt: text("updated_at").notNull(),
}, (t) => [check("microsoft_files_connection_singleton", sql`${t.id}=1`),
  check("microsoft_files_connection_status_valid", sql`${t.status} IN ('connected','disconnected','reconnect_required')`),
  check("microsoft_files_connection_target_valid", sql`(${t.driveId} IS NULL AND ${t.folderId} IS NULL AND ${t.folderName} IS NULL AND ${t.verifiedAt} IS NULL) OR (${t.driveId} IS NOT NULL AND ${t.folderId} IS NOT NULL AND ${t.folderName} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`)]);

export const jobDocumentsTable = pgTable("job_documents", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
  objectPath: text("object_path").notNull(), name: text("name").notNull(), size: integer("size").notNull(), sha256: text("sha256").notNull(),
  actorUserId: text("actor_user_id").notNull(), requestKey: text("request_key").notNull(), createdAt: text("created_at").notNull(),
}, (t) => [index("job_documents_job_idx").on(t.jobId), uniqueIndex("job_documents_object_unique").on(t.objectPath), uniqueIndex("job_documents_request_unique").on(t.requestKey),
  check("job_documents_size_valid", sql`${t.size} BETWEEN 1 AND 15728640`), check("job_documents_hash_valid", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`)]);

export const microsoftJobFoldersTable = pgTable("microsoft_job_folders", {
  jobId: text("job_id").primaryKey().references(() => jobsTable.id, { onDelete: "restrict" }), targetKey: text("target_key").notNull(),
  driveId: text("drive_id").notNull(), parentId: text("parent_id").notNull(), name: text("name").notNull(),
  itemId: text("item_id"), webUrl: text("web_url"), createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
});

/** Immutable attachment snapshot survives removal of a photo from its job panel;
 * it never gives permission to overwrite or delete the independent Microsoft copy. */
export const microsoftFileMirrorsTable = pgTable("microsoft_file_mirrors", {
  id: text("id").primaryKey(), jobId: text("job_id").notNull().references(() => jobsTable.id, { onDelete: "restrict" }),
  sourceType: text("source_type").$type<"document" | "photo">().notNull(), sourceId: text("source_id").notNull(), objectPath: text("object_path").notNull(),
  targetKey: text("target_key").notNull(), name: text("name").notNull(), remoteName: text("remote_name").notNull(), sha256: text("sha256").notNull(), size: integer("size").notNull(),
  status: text("status").$type<"syncing" | "synced" | "unknown" | "error">().notNull(), itemId: text("item_id"), webUrl: text("web_url"),
  leaseUntil: text("lease_until"), lastError: text("last_error"), actorUserId: text("actor_user_id").notNull(), requestKey: text("request_key").notNull(),
  attemptId: text("attempt_id").notNull(),
  createdAt: text("created_at").notNull(), updatedAt: text("updated_at").notNull(),
}, (t) => [index("microsoft_file_mirrors_job_idx").on(t.jobId), uniqueIndex("microsoft_file_mirrors_source_unique").on(t.sourceType, t.sourceId), uniqueIndex("microsoft_file_mirrors_request_unique").on(t.requestKey),
  check("microsoft_file_mirrors_source_valid", sql`${t.sourceType} IN ('document','photo')`),
  check("microsoft_file_mirrors_status_valid", sql`${t.status} IN ('syncing','synced','unknown','error')`),
  check("microsoft_file_mirrors_size_valid", sql`${t.size} BETWEEN 1 AND 15728640`), check("microsoft_file_mirrors_hash_valid", sql`${t.sha256} ~ '^[a-f0-9]{64}$'`),
  check("microsoft_file_mirrors_result_valid", sql`(${t.status}='synced' AND ${t.itemId} IS NOT NULL AND ${t.leaseUntil} IS NULL) OR (${t.status}<>'synced' AND ${t.itemId} IS NULL)`)]);
