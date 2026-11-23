export function createPlatform(options: any): {
  router: any;
  readiness(): Promise<any>;
  resolveTenant(host: string | undefined, path?: string): Promise<any>;
  startBillingWorker(): void;
  startProvisioningWorker(): void;
  migrate(): Promise<string>;
  upgradeTenants(): Promise<any[]>;
  close(): Promise<void>;
  getServices(options?: { allowUnmigrated?: boolean }): Promise<any>;
  billingTick(): Promise<void>;
  provisioningTick(): Promise<void>;
  enabled: boolean;
  origin?: string;
  legacyOrigin?: string;
};
