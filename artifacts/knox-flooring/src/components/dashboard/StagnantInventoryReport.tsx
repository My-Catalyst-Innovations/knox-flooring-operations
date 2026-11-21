import type { StagnantInventoryReport as StagnantStock } from "@workspace/api-client-react";
import { Link } from "wouter";
import { DataBoundary } from "@/components/layout/DataBoundary";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { currency, useOperation } from "@/lib/operations";

export function StagnantInventoryReport() {
  const query = useOperation<StagnantStock>("/metrics/stagnant-inventory", [
    "owner",
  ]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Stagnant inventory value</CardTitle>
        <p className="text-xs text-muted-foreground">
          Current stock by time since its last receipt, issue, adjustment or
          warehouse transfer. Moves between bins leave the age unchanged.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <DataBoundary query={query} name="stagnant inventory">
          {query.data && (
            <>
              <div className="overflow-x-auto">
                <table className="min-w-full text-sm">
                  <caption className="sr-only">
                    Stagnant inventory by age as of {query.data.asOfDate}
                  </caption>
                  <thead className="text-xs text-muted-foreground">
                    <tr>
                      <th scope="col" className="pb-2 text-left">
                        Inactive
                      </th>
                      <th scope="col" className="px-2 pb-2 text-right">
                        SKU locations
                      </th>
                      <th scope="col" className="px-2 pb-2 text-right">
                        Receipt cost
                      </th>
                      <th scope="col" className="px-2 pb-2 text-right">
                        Estimated
                      </th>
                      <th scope="col" className="pl-2 pb-2 text-right">
                        Incomplete value
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {query.data.windows.map((window) => (
                      <tr key={window.days} className="border-t tabular-nums">
                        <th
                          scope="row"
                          className="whitespace-nowrap py-2 pr-2 text-left font-medium"
                        >
                          {window.days}+ days
                        </th>
                        <td className="px-2 text-right">{window.locations}</td>
                        <td className="px-2 text-right">
                          {currency(window.receiptValue)}
                        </td>
                        <td className="px-2 text-right">
                          {currency(window.estimatedValue)}
                        </td>
                        <td className="pl-2 text-right">
                          {window.unvaluedLocations}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                Windows overlap. As of {query.data.asOfDate}.{" "}
                {query.data.unknownMovementLocations} stocked locations have no
                reliable movement date.
              </p>
            </>
          )}
        </DataBoundary>
        <Link
          href="/inventory"
          className="text-xs font-medium text-primary hover:underline"
        >
          Open inventory
        </Link>
      </CardContent>
    </Card>
  );
}
