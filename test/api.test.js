import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";
import { createToken, parseTokenLifetime, verifyToken } from "../src/auth.js";
import { isSupportedImage, uploadImageToImgBB } from "../src/image-upload.js";
import { createStore } from "../src/store.js";

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

test("customer orders require an available item, valid future delivery, and address", async () => {
  const customer = { id: "customer-1", name: "Customer", email: "customer@test.com", role: "customer", status: "active" };
  const vendor = { id: "vendor-1", name: "Oven", email: "vendor@test.com", role: "vendor", status: "active" };
  const store = {
    data: {
      users: [customer, vendor],
      menuItems: [
        { id: "available-pizza", name: "Available Pizza", category: "Classic", description: "Fresh", price: 12, location: "Downtown", vendor: "Oven", vendorId: "vendor-1", status: "approved", availability: "available" },
        { id: "unavailable-pizza", name: "Unavailable Pizza", category: "Classic", description: "Fresh", price: 12, location: "Downtown", vendor: "Oven", vendorId: "vendor-1", status: "approved", availability: "unavailable" }
      ],
      orders: [],
      transactions: []
    },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  const token = createToken(customer, "test-secret");
  const vendorToken = createToken(vendor, "test-secret");
  const postOrder = (body) => fetch(`${base}/api/orders`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const updateOrder = (status) => fetch(`${base}/api/orders/ord-1/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${vendorToken}` },
    body: JSON.stringify({ status })
  });
  try {
    const menu = await fetch(`${base}/api/menu`);
    assert.deepEqual((await menu.json()).items.map((item) => item.id), ["available-pizza"]);

    const unavailable = await postOrder({
      itemId: "unavailable-pizza",
      deliveryDate: new Date(Date.now() + 60_000).toISOString(),
      address: "1 Main Street"
    });
    assert.equal(unavailable.status, 404);

    const past = await postOrder({
      itemId: "available-pizza",
      deliveryDate: new Date(Date.now() - 60_000).toISOString(),
      address: "1 Main Street"
    });
    assert.equal(past.status, 400);

    const noAddress = await postOrder({
      itemId: "available-pizza",
      deliveryDate: new Date(Date.now() + 60_000).toISOString(),
      address: "   "
    });
    assert.equal(noAddress.status, 400);

    const response = await postOrder({
      itemId: "available-pizza",
      deliveryDate: new Date(Date.now() + 60_000).toISOString(),
      address: "  1 Main Street  "
    });
    assert.equal(response.status, 201);
    const { order } = await response.json();
    assert.equal(order.address, "1 Main Street");
    assert.equal(order.status, "pending");
    assert.equal(store.data.orders.length, 1);

    const accepted = await updateOrder("accepted");
    assert.equal(accepted.status, 200);
    const invalidTransition = await updateOrder("rejected");
    assert.equal(invalidTransition.status, 400);
    const delivered = await updateOrder("delivered");
    assert.equal(delivered.status, 200);
    assert.deepEqual(store.data.orders[0].timeline.map((entry) => entry.status), ["pending", "accepted", "delivered"]);
  } finally {
    server.close();
  }
});

test("vendor menu submissions are validated and remain hidden until approval", async () => {
  const vendor = { id: "vendor-1", name: "Little Oven", email: "vendor@test.com", role: "vendor", status: "active", subscriptionPlan: "free" };
  const store = {
    data: { users: [vendor], menuItems: [], orders: [], transactions: [] },
    persisted: false,
    async persist() { this.persisted = true; },
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  const token = createToken(vendor, "test-secret");
  const submit = (body) => fetch(`${base}/api/vendor/menu`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  try {
    const invalid = await submit({ name: "  ", category: "Classic", description: "Fresh", price: 12, location: "Downtown" });
    assert.equal(invalid.status, 400);

    const response = await submit({ name: "  Garden Slice  ", category: "Veggie", description: "  Fresh basil  ", price: "14.50", location: " Downtown " });
    assert.equal(response.status, 201);
    const { item } = await response.json();
    assert.equal(item.name, "Garden Slice");
    assert.equal(item.description, "Fresh basil");
    assert.equal(item.location, "Downtown");
    assert.equal(item.status, "pending");
    assert.equal(item.availability, "unavailable");
    assert.ok(Number.isFinite(Date.parse(item.createdAt)));
    assert.equal(store.persisted, true);

    const menu = await fetch(`${base}/api/menu`);
    assert.deepEqual((await menu.json()).items, []);
  } finally {
    server.close();
  }
});

test("free-plan menu limits are enforced when items become available", async () => {
  const vendor = { id: "vendor-1", name: "Little Oven", email: "vendor@test.com", role: "vendor", status: "active", subscriptionPlan: "free" };
  const admin = { id: "admin-1", name: "Admin", email: "admin@test.com", role: "admin", status: "active" };
  const menuItems = [1, 2, 3].map((number) => ({
    id: `active-${number}`,
    name: `Active ${number}`,
    vendorId: vendor.id,
    status: "approved",
    availability: "available"
  }));
  menuItems.push({ id: "pending-1", name: "Pending Pizza", vendorId: vendor.id, status: "pending", availability: "unavailable" });
  const store = {
    data: { users: [vendor, admin], menuItems, orders: [], transactions: [] },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  const vendorToken = createToken(vendor, "test-secret");
  const adminToken = createToken(admin, "test-secret");
  const updateAvailability = (itemId, availability) => fetch(`${base}/api/vendor/menu/${itemId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${vendorToken}` },
    body: JSON.stringify({ availability })
  });
  try {
    const approval = await fetch(`${base}/api/admin/menu/pending-1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "approved" })
    });
    assert.equal(approval.status, 200);
    assert.equal((await approval.json()).item.availability, "unavailable");

    const overLimit = await updateAvailability("pending-1", "available");
    assert.equal(overLimit.status, 402);

    const pauseItem = await updateAvailability("active-3", "unavailable");
    assert.equal(pauseItem.status, 200);
    const activate = await updateAvailability("pending-1", "available");
    assert.equal(activate.status, 200);
    assert.equal((await activate.json()).item.availability, "available");
  } finally {
    server.close();
  }
});

test("admin user status controls cannot block the acting admin", async () => {
  const admin = { id: "admin-1", name: "Admin", email: "admin@test.com", role: "admin", status: "active" };
  const customer = { id: "customer-1", name: "Customer", email: "customer@test.com", role: "customer", status: "active" };
  const store = {
    data: { users: [admin, customer], menuItems: [], orders: [], transactions: [] },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  const token = createToken(admin, "test-secret");
  const setStatus = (id, status) => fetch(`${base}/api/admin/users/${id}/status`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status })
  });
  try {
    const selfBlock = await setStatus(admin.id, "blocked");
    assert.equal(selfBlock.status, 400);
    assert.equal(admin.status, "active");

    const blockCustomer = await setStatus(customer.id, "blocked");
    assert.equal(blockCustomer.status, 200);
    assert.equal(customer.status, "blocked");
  } finally {
    server.close();
  }
});

test("file-backed auth supports registration and sign-in when Better Auth is disabled", async () => {
  const store = {
    data: { users: [], menuItems: [], orders: [], transactions: [] },
    async persist() {},
    nextId(prefix) { return `${prefix}-1`; }
  };
  const app = await createApp({ store, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  try {
    const providers = await fetch(`${base}/api/auth/providers`);
    assert.deepEqual(await providers.json(), { betterAuth: false, google: false });

    const registration = await fetch(`${base}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Test Vendor", email: "vendor@test.com", password: "secret123", role: "vendor" })
    });
    assert.equal(registration.status, 201);
    const registered = await registration.json();
    assert.equal(registered.user.role, "vendor");

    const login = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "vendor@test.com", password: "secret123" })
    });
    assert.equal(login.status, 200);
    const loggedIn = await login.json();
    const profile = await fetch(`${base}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loggedIn.token}` }
    });
    assert.equal(profile.status, 200);
    assert.equal((await profile.json()).user.email, "vendor@test.com");
  } finally {
    server.close();
  }
});

test("Better Auth sessions authenticate API requests and are mirrored into app state", async () => {
  const store = {
    data: { users: [], menuItems: [], orders: [], transactions: [] },
    persisted: false,
    async persist() { this.persisted = true; },
    nextId(prefix) { return `${prefix}-1`; }
  };
  const auth = {
    handler: async () => new Response(null, { status: 404 }),
    api: {
      async getSession() {
        return {
          user: {
            id: "better-auth-user",
            name: "New Customer",
            email: "customer@test.com",
            role: "customer",
            createdAt: new Date("2025-01-01T00:00:00.000Z")
          }
        };
      }
    }
  };
  const app = await createApp({ store, auth, tokenSecret: "test-secret" });
  const { server, base } = await listen(app);
  try {
    const response = await fetch(`${base}/api/auth/me`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.id, "better-auth-user");
    assert.equal(store.data.users[0].role, "customer");
    assert.equal(store.persisted, true);
  } finally {
    server.close();
  }
});

test("configured JWT lifetime is applied to demo tokens", () => {
  const before = Date.now();
  const token = createToken({ id: "user-1", role: "customer" }, "test-secret", "30m");
  const claims = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString("utf8"));
  assert.ok(claims.exp >= before + 30 * 60 * 1000);
  assert.ok(claims.exp <= Date.now() + 30 * 60 * 1000);
  assert.equal(verifyToken(token, "test-secret").sub, "user-1");
  assert.throws(() => parseTokenLifetime("zero"), /JWT_EXPIRES_IN/);
});

test("Mongo-backed store persists its state document", async () => {
  let document = null;
  const database = {
    collection(name) {
      assert.equal(name, "pizzaHubAppState");
      return {
        async findOne() { return document; },
        async insertOne(value) { document = value; },
        async updateOne(filter, update) { document = { _id: filter._id, ...update.$set }; }
      };
    }
  };

  const store = await createStore(database);
  store.data.users.push({ id: "new-user" });
  await store.persist();

  assert.equal(document._id, "main");
  assert.equal(document.data.users.at(-1).id, "new-user");
});

test("profile image upload validates, stores the hosted URL, and reports ImgBB failures", async (t) => {
  const vendor = { id: "vendor-1", name: "Vendor", email: "vendor@test.com", role: "vendor", status: "active", passwordHash: "" };
  const store = {
    data: { users: [vendor], menuItems: [], orders: [], transactions: [] },
    persisted: false,
    async persist() { this.persisted = true; },
    nextId(prefix) { return `${prefix}-1`; }
  };
  let uploadedFile;
  let uploadFailure;
  t.mock.method(console, "error", () => {});
  const app = await createApp({
    store,
    tokenSecret: "test-secret",
    imgbbApiKey: "test-api-key",
    async imageUploader(file, apiKey) {
      assert.equal(apiKey, "test-api-key");
      uploadedFile = file;
      if (uploadFailure) throw uploadFailure;
      return "https://i.ibb.co/test/profile.png";
    }
  });
  const { server, base } = await listen(app);
  try {
    const token = createToken(vendor, "test-secret");
    const image = new FormData();
    const pngSignature = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    image.append("image", new Blob([pngSignature], { type: "image/png" }), "profile.png");
    const response = await fetch(`${base}/api/vendor/profile/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: image
    });

    assert.equal(response.status, 201);
    assert.equal((await response.json()).image, "https://i.ibb.co/test/profile.png");
    assert.equal(uploadedFile.mimetype, "image/png");
    assert.equal(uploadedFile.originalname, "profile.png");
    assert.equal(vendor.image, "https://i.ibb.co/test/profile.png");
    assert.equal(store.persisted, true);

    const invalidFile = new FormData();
    invalidFile.append("image", new Blob(["not an image"], { type: "text/plain" }), "notes.txt");
    const invalidResponse = await fetch(`${base}/api/vendor/profile/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: invalidFile
    });
    assert.equal(invalidResponse.status, 415);

    uploadFailure = new Error("ImgBB rejected the image upload: Invalid API key");
    const failedImage = new FormData();
    failedImage.append("image", new Blob([pngSignature], { type: "image/png" }), "profile.png");
    const failedResponse = await fetch(`${base}/api/vendor/profile/image`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: failedImage
    });
    assert.equal(failedResponse.status, 502);
    assert.equal((await failedResponse.json()).message, "ImgBB rejected the image upload: Invalid API key");
  } finally {
    server.close();
  }
});

test("ImgBB helper sends multipart data and returns the hosted URL", async (t) => {
  let rejectUpload = false;
  t.mock.method(globalThis, "fetch", async (input, options) => {
    const endpoint = new URL(input);
    assert.equal(endpoint.origin, "https://api.imgbb.com");
    assert.equal(endpoint.pathname, "/1/upload");
    assert.equal(endpoint.searchParams.get("key"), "test-api-key");
    assert.ok(options.body instanceof FormData);
    assert.equal(options.body.get("image").type, "image/png");
    assert.equal(options.body.get("image").name, "pizza.png");
    if (rejectUpload) {
      return new Response(JSON.stringify({
        success: false,
        error: { message: "Invalid API key" }
      }), { status: 400, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify({
      success: true,
      data: { display_url: "https://i.ibb.co/test/profile.png" }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  });

  const image = await uploadImageToImgBB({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mimetype: "image/png",
    originalname: "pizza.png"
  }, "test-api-key");

  assert.equal(image, "https://i.ibb.co/test/profile.png");
  rejectUpload = true;
  await assert.rejects(
    uploadImageToImgBB({
      buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimetype: "image/png",
      originalname: "pizza.png"
    }, "test-api-key"),
    /ImgBB rejected the image upload: Invalid API key/
  );
  assert.equal(isSupportedImage({
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    mimetype: "image/png"
  }), true);
  assert.equal(isSupportedImage({
    buffer: Buffer.from("not actually an image"),
    mimetype: "image/png"
  }), false);
});
