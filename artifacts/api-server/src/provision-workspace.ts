import { parseArgs } from "node:util";
import { assertMigrationsApplied, closeWorkspaceConnections, pool } from "@workspace/db";
import { inWorkspace, workspaceConfigs } from "@workspace/db/workspace";
import { prepareWorkspaceOwner } from "./routes/staff";
import { workspaceProvisionDiagnostic } from "./lib/safe-logging";

try {
  if (process.env.READ_ONLY_RECOVERY === "true") throw new Error("Workspace setup is unavailable in recovery mode.");
  const { values } = parseArgs({ options: {
    workspace: { type: "string" },
    company: { type: "string" },
    "owner-name": { type: "string" },
    "owner-email": { type: "string" },
    adopt: { type: "boolean" },
  } });
  const workspace = workspaceConfigs.find(({ key }) => key === values.workspace);
  const { company, "owner-name": name, "owner-email": email } = values;
  if (!workspace || !company || !name || !email)
    throw new Error("Provide --workspace, --company, --owner-name, and --owner-email for a configured workspace.");
  const result = await inWorkspace(workspace, async () => {
    await assertMigrationsApplied(pool);
    return prepareWorkspaceOwner({ company, name, email, adopt: values.adopt ?? false });
  });
  if (result.adopted) console.log("Existing company bound to the workspace address.");
  else console.log(JSON.stringify({ invitationUrl: result.url, expiresAt: result.expiresAt }));
} catch (error) {
  console.error(JSON.stringify(workspaceProvisionDiagnostic(error)));
  process.exitCode = 1;
} finally {
  await closeWorkspaceConnections();
}
