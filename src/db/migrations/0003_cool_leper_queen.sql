CREATE INDEX "collections_account_id_idx" ON "collections" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "records_version_id_type_idx" ON "records" USING btree ("version_id","type");--> statement-breakpoint
CREATE INDEX "version_files_file_hash_idx" ON "version_files" USING btree ("file_hash");