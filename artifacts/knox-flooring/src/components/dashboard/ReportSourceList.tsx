import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

const pageSize = 20;

export function ReportSourceList<T>({
  label,
  records,
  recordKey,
  children,
}: {
  label: string;
  records: readonly T[];
  recordKey: (record: T) => string;
  children: (record: T) => ReactNode;
}) {
  const [limit, setLimit] = useState(pageSize);
  if (!records.length) return null;
  return (
    <details className="border-t pt-2 text-sm">
      <summary className="cursor-pointer font-medium text-primary">
        {label} ({records.length})
      </summary>
      <ul className="mt-2 divide-y">
        {records.slice(0, limit).map((record) => (
          <li key={recordKey(record)} className="space-y-1 py-2 break-words">
            {children(record)}
          </li>
        ))}
      </ul>
      {limit < records.length && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={() => setLimit((current) => current + pageSize)}
        >
          Show more records
        </Button>
      )}
    </details>
  );
}

export function ReportRecordLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <Link href={href} className="font-medium text-primary hover:underline">
      {children}
    </Link>
  );
}
