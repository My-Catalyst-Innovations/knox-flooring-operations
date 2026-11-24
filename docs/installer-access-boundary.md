# Installer assignment and operational access

This source change hardens existing installer APIs. It is not a staff invitation,
deployment, public signup, company import, or provider activation.

An installer can access a job only through a task whose `assigneeId` is the
signed-in user's ID and whose `relatedJobId` is that job. Supported task states
are `Open` and `Done`. If the task has a booking, both linkage directions must
agree (`task.bookingId`, `booking.taskId`, and their job IDs), and the booking
must remain `Confirmed`. A crew name, crew ID, actual-owner identity during role
preview, or possession of a file path does not grant access.

Installer job responses do not select raw `scopeOfWork`: quote conversion can put
estimated prices in that text. They return a neutral flooring-type and validated
room-count summary instead. Nested rooms expose only ID, name and finite
dimensions; freeform room scope is omitted too. No regex attempts to sanitize
arbitrary financial prose. Full office job views retain their original scope;
installers confirm detailed instructions with their assigned task and the office.

The existing database-per-company request context applies to every query. Grants,
staff, files and IDs in another company's database cannot satisfy this check.

## Installer route coverage

| Route                           | Installer behavior                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /jobs` and `/jobs/:id`     | Assigned jobs only; explicit operational fields and nested room whitelist                                                             |
| `GET /tasks`                    | Own supported job-linked tasks only; no description, provider event ID, lead or other assignee records                                |
| `PATCH /tasks/:id`              | Own task `status: Open` or `Done` only; no cancellation, reassignment, scheduling or provider push                                    |
| `GET/POST /jobs/:id/updates`    | Assigned job; read own updates, append with server-verified author and UUID replay protection                                         |
| `GET /jobs/:id/entry-context`   | Only explicitly assigned confirmed bookings/crews and material requirements; no callbacks                                             |
| `GET /jobs/:id/materials`       | Assigned job requirements: name, quantity and unit                                                                                    |
| `GET/POST /jobs/:id/photos`     | Assigned private photos; append only a private job-photo upload owned by this user for this job                                       |
| `GET /jobs/:id/labor`           | Team time for the exact assigned confirmed bookings; no rate, cost, accounting state or provider references                           |
| `POST /jobs/:id/labor`          | Ordinary unreviewed team time with explicit booking/crew/date/hours; no payroll, billable rate, acquisition cost or accounting fields |
| `GET /jobs/:id/material-usage`  | Assigned job quantities only; no costs, vendor/account references or financial notes                                                  |
| `POST /storage/files/job-photo` | Assigned job only, private upload, grant held through the bounded object write                                                        |
| `GET /storage/objects/*`        | Current assignment required for managed photo previews/attachments and legacy job photos; uploader ownership alone is insufficient    |
| `GET /workspace-brand`          | Existing company branding behavior                                                                                                    |

All other installer protected routes fail closed before the legacy router runs.
This includes job creation/deletion/PATCH, stage/readiness controls, task
creation/deletion/reassignment, financial/accounting records, material requirement
changes, material usage writes, labor/photo edits/deletes, portal publication,
public-object searches and integration controls. The customer share portal remains
separate; private job responses never disclose its token.

No creator is stored on legacy labor/material/photo rows. Installers therefore
cannot edit or delete those rows. Office staff handle corrections, actual costs,
callbacks and stock issues. New ordinary team time remains unpriced/unreviewed
until the office completes its separate accounting review.

## Trusted booking-task assignment

Owners and operations staff can assign an existing supported task on a confirmed,
correctly linked installation through the booking dialog. Role preview cannot use
this control. The roster endpoint returns only active accepted staff IDs, display
names and roles; no email addresses or credentials.

- `GET /tasks/assignees` returns the minimal roster.
- `GET /tasks/:id/assignment` returns current binding and optimistic versions.
- `PATCH /tasks/:id/assignment` accepts only `assigneeId` (or null), the saved
  `updatedAt`, and `bookingRevision`.

The write rechecks the job, crew/booking/task linkage, active same-company staff
and both optimistic versions under locks. Its task timestamp advances strictly.
It changes only assignee and timestamp. Crew, dates, capacity, job stage and all
calendar/email/SMS/provider state remain unchanged. Schedule changes continue
through Crew Schedule. A crew booking still has one personally assigned task;
this change does not invent multi-person membership.

## Concurrency and verification

Mutation authorization is rechecked inside the transaction. Job, task and booking
locks retain the actual grant through the write. Reassignment committed first
causes the waiting request to fail; a currently authorized upload blocks grant
revocation until its private object write completes. Existing file size and
provider timeouts bound that upload. Deadlock/serialization conflicts return a
rolled-back 409 through the existing domain handler.

Meaningful tests cover actual password/cookie/CSRF sessions, owner role preview,
unassigned and cancelled/malformed grants, explicit booking labor, inactive staff,
optimistic assignment, denied-action side-effect snapshots, two isolated tenant
databases, private/legacy/preview/attachment file reads, and both upload versus
reassignment orderings against real PostgreSQL with a simulated Blob provider.

The separate live work-guide slice supplies a standalone installer screen. The
legacy global dashboard and crew-level actuals form are not redesigned here;
that older labor form lacks an explicit booking selector and does not satisfy the
new narrow installer input contract. Keep installer rollout gated on integrating
and checking the safe guide flow. There is no claim that all installer data-entry
screens, broader onboarding/imports or historical archive are complete.
