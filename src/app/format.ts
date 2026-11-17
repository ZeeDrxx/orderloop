export function money(amount: string | number | null | undefined, currency = "MAD"): string {
  if (amount === null || amount === undefined) return "–";
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency, maximumFractionDigits: 0 }).format(Number(amount));
}

export function day(d: Date | string | null | undefined): string {
  if (!d) return "–";
  return new Date(d).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function ago(d: Date | string): string {
  const mins = Math.round((Date.now() - new Date(d).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}
