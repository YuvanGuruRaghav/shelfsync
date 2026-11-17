import "./globals.css";

export const metadata = {
  title: "ShelfSync",
  description: "Every shelf, every city, always in sync.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
