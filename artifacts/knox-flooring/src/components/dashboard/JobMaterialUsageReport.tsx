import type { OperationalMetrics } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const quantity = (value: number) =>
  value.toLocaleString("en-US", { maximumFractionDigits: 6 });

export function JobMaterialUsageReport({
  usage,
}: {
  usage: OperationalMetrics["materialUsageReport"];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Approved material and recorded use
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Stocked items in accepted quotes for jobs closed in the report period.
          Net issued quantities subtract recorded returns.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {usage.rows.length ? (
          <table className="w-full">
            <caption className="sr-only">
              Approved stock and net issued quantity by product
            </caption>
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="pb-2 text-left">
                  Product
                </th>
                <th scope="col" className="pb-2 px-1 text-right">
                  Approved
                </th>
                <th scope="col" className="pb-2 text-right">
                  Net issued
                </th>
              </tr>
            </thead>
            <tbody>
              {usage.rows.map((row) => (
                <tr key={row.productId} className="border-t">
                  <th scope="row" className="py-2 pr-2 text-left font-medium">
                    <span className="block break-words">{row.productName}</span>
                    <span className="text-xs font-normal text-muted-foreground">
                      {[row.sku, row.unit].filter(Boolean).join(" · ")}
                    </span>
                  </th>
                  <td className="px-1 text-right tabular-nums">
                    {quantity(row.approvedQuantity)}
                  </td>
                  <td className="text-right tabular-nums">
                    {quantity(row.netIssuedQuantity)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No comparable approved stock quantities in this period.</p>
        )}
        <p className="text-xs text-muted-foreground">
          {usage.comparableJobs} comparable jobs · {usage.unknownJobs} without a
          single accepted quote and matching stocked units.
        </p>
      </CardContent>
    </Card>
  );
}
