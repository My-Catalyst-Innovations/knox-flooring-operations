CREATE TABLE public.job_updates (
  id text PRIMARY KEY,
  job_id text NOT NULL,
  author_id text NOT NULL,
  author_name text NOT NULL,
  message text NOT NULL,
  created_at text NOT NULL,
  CONSTRAINT job_updates_job_id_jobs_id_fk FOREIGN KEY (job_id) REFERENCES public.jobs(id) ON DELETE RESTRICT
);
--> statement-breakpoint

CREATE INDEX job_updates_job_created_idx ON public.job_updates(job_id, created_at);
