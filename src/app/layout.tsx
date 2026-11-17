import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";

export const metadata: Metadata = {
  title: { default: "OrderLoop", template: "%s · OrderLoop" },
  description: "Order-to-cash tracking on top of SAP S/4HANA: orders, deliveries, invoices and payments in one place.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header>
          <nav>
            <Link href="/" className="brand">OrderLoop</Link>
            <Link href="/">Overview</Link>
            <Link href="/orders">Orders</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
