import ProductDetail from "./ProductDetail";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }) {
  const { id } = await params;
  return { title: `Product ${id} · ShelfSync` };
}

export default async function ProductPage({ params }) {
  const { id } = await params;
  return <ProductDetail key={id} productId={id} />;
}
