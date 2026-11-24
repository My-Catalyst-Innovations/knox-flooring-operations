import { Link } from "wouter";
import { quickBooksEntryPaths } from "@workspace/domain";
import { ProductBrand } from "@/components/layout/Brand";

export default function QuickBooksHelp() {
  return (
    <main className="mx-auto min-h-screen max-w-3xl space-y-6 px-5 py-8 sm:py-12">
      <ProductBrand />
      <h1 className="text-3xl font-semibold">QuickBooks connection help</h1>
      <p>
        These pages support an existing Catalyst Works company workspace. Your
        implementation contact supplies access; a connection link does not
        create an account or select a different company.
      </p>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">
          Connect or renew authorization
        </h2>
        <ol className="list-decimal space-y-2 pl-5">
          <li>
            Sign in to the correct Works workspace as its owner, outside role
            preview.
          </li>
          <li>
            Open the{" "}
            <Link
              href={quickBooksEntryPaths.launch}
              className="text-primary underline"
            >
              connection overview
            </Link>
            . Review the saved company and whether it is a sandbox or production
            connection.
          </li>
          <li>
            Choose{" "}
            <Link
              href={quickBooksEntryPaths.connect}
              className="text-primary underline"
            >
              Connect
            </Link>{" "}
            or{" "}
            <Link
              href={quickBooksEntryPaths.reconnect}
              className="text-primary underline"
            >
              Reconnect
            </Link>{" "}
            and explicitly continue to Intuit. Use an account allowed to
            authorize apps for the intended QuickBooks company.
          </li>
          <li>
            After returning to Works, review the saved connection in Settings. A
            return link alone does not prove a successful connection.
          </li>
        </ol>
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Stop the connection</h2>
        <p>
          Use the{" "}
          <Link
            href={quickBooksEntryPaths.disconnect}
            className="text-primary underline"
          >
            disconnect page
          </Link>{" "}
          and confirm the saved connection before requesting a stop. Works stops
          local use before requesting Intuit revocation. It retains jobs,
          mappings and submitted accounting history.
        </p>
        <p>
          Pending, failed or unknown revocation is not confirmed revocation.
          Reload the saved state and use only the explicit retry for the same
          stopped grant. New authorization remains paused until revocation is
          resolved. Closing this page never confirms an interrupted request.
        </p>
      </section>
      <section className="space-y-3">
        <h2 className="text-xl font-semibold">Review accounting separately</h2>
        <p>
          Authorizing QuickBooks does not approve financial entries, import
          opening balances or verify inventory matches. Review company identity,
          item mappings, negotiated supplier prices, units, taxes and each
          accounting document inside your workspace. Sandbox and production must
          be checked separately.
        </p>
        <p>
          If the page reports setup is unavailable, the saved state needs
          review, or the expected company is missing, contact your existing
          implementation contact. Keep sensitive tokens, invoices and passwords
          out of support URLs.
        </p>
      </section>
      <nav
        aria-label="QuickBooks help links"
        className="flex flex-wrap gap-4 text-sm"
      >
        <Link
          href={quickBooksEntryPaths.launch}
          className="text-primary underline"
        >
          Connection overview
        </Link>
        <Link href="/welcome" className="text-primary underline">
          Workspace sign-in
        </Link>
        <a href="/privacy" className="text-primary underline">
          Privacy notice
        </a>
        <a href="/terms" className="text-primary underline">
          Terms of use
        </a>
      </nav>
    </main>
  );
}
