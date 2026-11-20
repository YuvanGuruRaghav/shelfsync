import { Plus_Jakarta_Sans } from "next/font/google";

import "./globals.css";

import Header from "@/components/Header";
import { StoreProvider } from "@/lib/StoreContext";

const jakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jakarta",
});

export const metadata = {
  title: "ShelfSync",
  description: "Every shelf, every city, always in sync.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${jakarta.variable} min-h-screen bg-canvas font-sans text-slate-900 antialiased`}>
        <StoreProvider>
          <Header />
          <main className="container-page py-8">{children}</main>
        </StoreProvider>
      </body>
    </html>
  );
}
