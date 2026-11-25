import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const address = server.address();
  return { server, base: `http://127.0.0.1:${address.port}` };
}

test("health and public menu endpoints work", async () => {
  const store = {
    data: {
      users: [{ id: "admin", name: "Admin", email: "admin@test.com", passwordHash: "", role: "admin", status: "active" }],
      menuItems: [{ id: "pizza", name: "Test Pizza", category: "Classic", description: "Tasty", price: 10, location: "Downtown", vendor: "Test Oven", vendorId: "vendor", status: "approved", availability: "available" }],
      orders: [],
      transactions: []
    },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    const menu = await fetch(`${base}/api/menu`);
    assert.equal(menu.status, 200);
    assert.equal((await menu.json()).items.length, 1);
  } finally {
    server.close();
  }
});

test("authentication rejects invalid credentials", async () => {
  const store = {
    data: { users: [], menuItems: [], orders: [], transactions: [] },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "none@test.com", password: "wrong" }) });
    assert.equal(response.status, 401);
  } finally {
    server.close();
  }
});
