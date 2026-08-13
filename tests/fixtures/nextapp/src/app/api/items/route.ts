export async function GET() {
  return Response.json({ items: [{ id: 1, name: "Widget" }] });
}

export async function POST(request: Request) {
  const body = (await request.json()) as { name: string };
  return Response.json({ id: 2, name: body.name }, { status: 201 });
}
