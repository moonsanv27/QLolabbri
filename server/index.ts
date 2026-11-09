import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createApp } from "./app";
import { LocalPrototypeStore, SupabaseStore } from "./store";
import { createSupabaseAdminClient } from "./supabase-client";
const root = fileURLToPath(new URL("../", import.meta.url));
try {
  process.loadEnvFile?.(path.join(root, ".env"));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const production =
  process.env.NODE_ENV === "production" ||
  process.argv.includes("--production");
const port = Number(process.env.PORT || 4173);
const origin =
  process.env.APP_ORIGIN ||
  process.env.RENDER_EXTERNAL_URL ||
  `http://127.0.0.1:${port}`;
if (
  production &&
  (!process.env.SUPABASE_URL ||
    !process.env.SUPABASE_SECRET_KEY ||
    !process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET.length < 32 ||
    !origin.startsWith("https://"))
)
  throw new Error(
    "Production requires SUPABASE_URL, SUPABASE_SECRET_KEY, a 32+ character SESSION_SECRET, and an HTTPS APP_ORIGIN.",
  );
if (
  Boolean(process.env.SUPABASE_URL) !== Boolean(process.env.SUPABASE_SECRET_KEY)
)
  throw new Error("Set both SUPABASE_URL and SUPABASE_SECRET_KEY.");
const supabase =
  process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY
    ? createSupabaseAdminClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SECRET_KEY,
      )
    : undefined;
const store = supabase
  ? new SupabaseStore(supabase)
  : await LocalPrototypeStore.create(
      path.resolve(root, process.env.LOCAL_DATA_FILE || ".data/nusa.json"),
    );
if (store instanceof SupabaseStore) await store.checkConnection();
const { app } = await createApp({
  store,
  supabase,
  production,
  origin,
  sessionSecret: process.env.SESSION_SECRET || randomBytes(48).toString("hex"),
  test: process.env.E2E_TEST === "1",
});
const server = createServer(app);
let vite:
  Awaited<ReturnType<(typeof import("vite"))["createServer"]>> | undefined;
if (production) {
  app.use(
    express.static(path.join(root, "dist"), { index: false, dotfiles: "deny" }),
  );
  app.get("/{*path}", (_request, response) =>
    response.sendFile(path.join(root, "dist/index.html")),
  );
} else {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    root,
    server: {
      middlewareMode: true,
      hmr: { server },
      fs: {
        strict: true,
        allow: [root],
        deny: [
          ".env",
          ".env.*",
          "**/.data/**",
          "**/server/**",
          "**/database/**",
          "**/*.{pem,key}",
        ],
      },
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}
server.listen(port, production ? "0.0.0.0" : "127.0.0.1", () => {
  console.log(`Nusa Corporate: ${origin}`);
  console.log(
    supabase
      ? "Persistence: Supabase Data API"
      : "Persistence: explicit local prototype (.data JSON).",
  );
});
let stopping = false;
async function close() {
  if (stopping) return;
  stopping = true;
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await vite?.close();
  await store.close();
  process.exit(0);
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
