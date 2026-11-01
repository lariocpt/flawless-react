// @ts-nocheck — hono resolves through the fixture's (uninstalled) node_modules.
// hono-style catch-all: every API path arrives through this one route file,
// which is what flattens a derived spec to a single "/api/{route}" path.
import { Hono } from "hono";

const apiApp = new Hono();

apiApp.get("/me", (c) => c.json({ name: "owner" }));
apiApp.get("/items", (c) => c.json([]));
apiApp.post("/items", (c) => c.json({ id: "1" }));

export const GET = (req: Request) => apiApp.fetch(req);
export const POST = (req: Request) => apiApp.fetch(req);
