import "./globals.css";

import Header from "@/components/Header";
import { StoreProvider } from "@/lib/StoreContext";

export const metadata = {
  title: "ShelfSync",
  description: "Every shelf, every city, always in sync.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="min-h-screen bg-neutral-50 text-neutral-900 antialiased">
        <StoreProvider>
          <Header />
          <main className="mx-auto w-full max-w-5xl px-4 py-6">{children}</main>
        </StoreProvider>
      </body>
    </html>
  );
}
