import { readFile } from "node:fs/promises";
import { policyReviewPacket } from "./lib/product-policies";

// Operator-only local tool. It neither reads deployment credentials nor publishes.
async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--fields-file"))
    throw new Error("usage");
  let fields: unknown = {};
  if (args.length) {
    const bytes = await readFile(args[1]);
    if (bytes.length > 100_000) throw new Error("bounds");
    fields = JSON.parse(bytes.toString("utf8"));
  }
  process.stdout.write(
    JSON.stringify(policyReviewPacket(fields), null, 2) + "\n",
  );
}
main().catch(() => {
  process.stderr.write(
    "Policy review packet could not be prepared. Use an optional --fields-file containing reviewed public fields only. No publication was performed.\n",
  );
  process.exitCode = 1;
});
