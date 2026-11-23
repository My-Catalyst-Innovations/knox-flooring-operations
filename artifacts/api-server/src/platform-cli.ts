// The dedicated provisioner has no default tenant database connection or fallback.
process.env.PLATFORM_PROCESS_ROLE = ["provisioner", "upgrade-tenants"].includes(
  process.argv[2],
)
  ? "provisioner"
  : "control";
const { platform, closePlatformServices } = await import("./platform");
try {
  const command = process.argv[2];
  if (command === "migrate") {
    console.log(JSON.stringify({ version: await platform.migrate() }));
    await closePlatformServices();
  } else if (command === "upgrade-tenants") {
    const results = await platform.upgradeTenants();
    console.log(JSON.stringify(results));
    if (results.some((result) => result.status === "failed"))
      process.exitCode = 1;
    await closePlatformServices();
  } else if (command === "status") {
    console.log(JSON.stringify(await platform.readiness()));
    await closePlatformServices();
  } else if (command === "billing-worker" || command === "provisioner") {
    if (command === "billing-worker") platform.startBillingWorker();
    else platform.startProvisioningWorker();
    const keepAlive = setInterval(() => {}, 3_600_000);
    const stop = () => {
      clearInterval(keepAlive);
      void closePlatformServices().finally(() => {
        process.exitCode = 0;
      });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
  } else
    throw new Error(
      "Use migrate, upgrade-tenants, status, billing-worker, or provisioner.",
    );
} catch {
  console.error(
    "The company platform command could not complete. Check its configuration and private operator logs.",
  );
  await closePlatformServices();
  process.exitCode = 1;
}
export {};
