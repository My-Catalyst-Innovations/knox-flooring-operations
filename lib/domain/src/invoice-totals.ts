type InvoicePrice = { quantity: number; unitPrice: number };

function lineCents({ quantity, unitPrice }: InvoicePrice): number {
  const cents = quantity * unitPrice * 100;
  return Math.round(cents + Math.abs(cents) * Number.EPSILON);
}

export function invoiceLineAmount(line: InvoicePrice): number {
  return lineCents(line) / 100;
}

export function invoiceSubtotal(lines: readonly InvoicePrice[]): number {
  return lines.reduce((cents, line) => cents + lineCents(line), 0) / 100;
}
