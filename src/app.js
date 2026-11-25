import express from "express";
import cors from "cors";
import multer from "multer";
import { fromNodeHeaders, toNodeHandler } from "better-auth/node";
import { createStore, hashPassword, verifyPassword } from "./store.js";
import { createToken, verifyToken } from "./auth.js";
import { isSupportedImage, uploadImageToImgBB } from "./image-upload.js";

export async function createApp(options = {}) {
  const app = express();
  const store = options.store || await createStore();
  const auth = options.auth;
  const imageUploader = options.imageUploader || uploadImageToImgBB;
  const imgbbApiKey = options.imgbbApiKey ?? process.env.IMGBB_API_KEY;
  const secret = options.tokenSecret || process.env.JWT_SECRET || process.env.TOKEN_SECRET || "development-only-secret";
  const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
  const profileImageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
    fileFilter(req, file, callback) {
      if (!file.mimetype.startsWith("image/")) {
        return callback(new Error("Only image files are allowed"));
      }
      callback(null, true);
    },
  }).single("image");
  store.data.favorites ||= [];
  store.data.reviews ||= [];
  store.data.emailNotifications ||= [];

  app.use(cors({
    origin: allowedOrigin === "*" ? "*" : allowedOrigin.split(",").map((value) => value.trim()),
    credentials: true,
  }));
  if (auth) app.all("/api/better-auth/*", toNodeHandler(auth));
  app.use(express.json({ limit: "1mb" }));

  const publicUser = ({ passwordHash, ...user }) => user;

  async function authenticate(req, res, next) {
    try {
      let user = null;
      if (auth) {
        const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
        if (session?.user) {
          user = store.data.users.find((entry) => entry.id === session.user.id);
          if (!user) {
            user = {
              id: session.user.id,
              name: session.user.name,
              email: session.user.email,
              image: session.user.image,
              role: session.user.role === "vendor" ? "vendor" : "customer",
              status: "active",
              createdAt: session.user.createdAt?.toISOString?.() || new Date().toISOString(),
            };
            store.data.users.push(user);
            await store.persist();
          }
        }
      }

      if (!user) {
        const header = req.headers.authorization || "";
        const token = header.startsWith("Bearer ") ? header.slice(7) : null;
        const claims = verifyToken(token, secret);
        user = claims ? store.data.users.find((entry) => entry.id === claims.sub) : null;
      }

      if (!user || user.status !== "active") return res.status(401).json({ message: "Authentication required" });
      req.user = user;
      next();
    } catch (error) {
      next(error);
    }
  }

  function authorize(...roles) {
    return (req, res, next) => roles.includes(req.user.role)
      ? next()
      : res.status(403).json({ message: "You do not have permission for this action" });
  }

  app.get("/api/health", (req, res) => res.json({ status: "ok", service: "PizzaHub API" }));
  app.get("/api/auth/providers", (req, res) => res.json({
    betterAuth: Boolean(auth),
    google: Boolean(auth && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  }));

  app.post("/api/auth/register", async (req, res, next) => {
    try {
      const { name, email, password, role = "customer" } = req.body;
      if (!name || !email || !password) return res.status(400).json({ message: "Name, email, and password are required" });
      if (password.length < 6) return res.status(400).json({ message: "Password must be at least 6 characters" });
      if (!["customer", "vendor"].includes(role)) return res.status(400).json({ message: "Invalid account role" });
      if (store.data.users.some((user) => user.email.toLowerCase() === email.toLowerCase())) {
        return res.status(409).json({ message: "An account already exists with this email" });
      }
      const user = { id: store.nextId("usr"), name: name.trim(), email: email.trim().toLowerCase(), passwordHash: hashPassword(password), role, status: "active", createdAt: new Date().toISOString() };
      store.data.users.push(user);
      await store.persist();
      res.status(201).json({ token: createToken(user, secret), user: publicUser(user) });
    } catch (error) { next(error); }
  });

  app.post("/api/auth/login", async (req, res) => {
    const { email, password } = req.body;
    const user = store.data.users.find((entry) => entry.email.toLowerCase() === String(email || "").toLowerCase());
    if (!user || user.status !== "active" || !verifyPassword(password || "", user.passwordHash)) {
      return res.status(401).json({ message: "Invalid email or password" });
    }
    res.json({ token: createToken(user, secret), user: publicUser(user) });
  });

  app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: publicUser(req.user) }));

  app.patch("/api/auth/profile", authenticate, async (req, res, next) => {
    try {
      const allowed = ["name", "image", "businessName"];
      for (const key of allowed) {
        if (Object.hasOwn(req.body, key)) req.user[key] = String(req.body[key]).trim();
      }
      await store.persist();
      res.json({ user: publicUser(req.user) });
    } catch (error) { next(error); }
  });

  app.get("/api/menu", (req, res) => {
    const { category, location, query, sort } = req.query;
    let items = store.data.menuItems.filter((item) => item.status === "approved" && item.availability === "available");
    if (category && category !== "All slices") items = items.filter((item) => item.category === category);
    if (location && location !== "All locations") items = items.filter((item) => item.location === location);
    if (query) {
      const normalized = String(query).toLowerCase();
      items = items.filter((item) => [item.name, item.description, item.vendor].some((value) => String(value).toLowerCase().includes(normalized)));
    }
    if (sort === "price-asc") items = [...items].sort((a, b) => a.price - b.price);
    if (sort === "price-desc") items = [...items].sort((a, b) => b.price - a.price);
    res.json({ items });
  });

  app.get("/api/menu/:id", (req, res) => {
    const item = store.data.menuItems.find((entry) => entry.id === req.params.id && entry.status === "approved" && entry.availability === "available");
    if (!item) return res.status(404).json({ message: "Menu item not found" });
    res.json({ item });
  });

  app.get("/api/vendor/menu", authenticate, authorize("vendor", "admin"), (req, res) => {
    const items = req.user.role === "admin"
      ? store.data.menuItems
      : store.data.menuItems.filter((item) => item.vendorId === req.user.id);
    res.json({ items });
  });

  app.post("/api/vendor/menu", authenticate, authorize("vendor"), async (req, res, next) => {
    try {
      const { name, category, description, price, location, image } = req.body;
      const itemName = String(name || "").trim();
      const itemCategory = String(category || "").trim();
      const itemDescription = String(description || "").trim();
      const itemLocation = String(location || "").trim();
      if (!itemName || !itemCategory || !itemDescription || !itemLocation || price === undefined || price === "") {
        return res.status(400).json({ message: "Name, category, description, location, and price are required" });
      }
      const numericPrice = Number(price);
      if (!Number.isFinite(numericPrice) || numericPrice < 0) return res.status(400).json({ message: "Price must be a valid nonnegative number" });
      const item = { id: store.nextId("menu"), name: itemName, category: itemCategory, description: itemDescription, price: numericPrice, rating: "New", time: "25-30 min", tag: "New", location: itemLocation, vendor: req.user.name, vendorId: req.user.id, image: String(image || "").trim(), status: "pending", availability: "unavailable", createdAt: new Date().toISOString() };
      store.data.menuItems.push(item);
      await store.persist();
      res.status(201).json({ item });
    } catch (error) { next(error); }
  });

  app.patch("/api/vendor/menu/:id", authenticate, authorize("vendor", "admin"), async (req, res, next) => {
    try {
      const item = store.data.menuItems.find((entry) => entry.id === req.params.id);
      if (!item) return res.status(404).json({ message: "Menu item not found" });
      if (req.user.role === "vendor" && item.vendorId !== req.user.id) return res.status(403).json({ message: "This item belongs to another vendor" });
      const allowed = ["name", "category", "description", "price", "location", "image", "availability"];
      if (Object.hasOwn(req.body, "availability")) {
        if (!["available", "unavailable"].includes(req.body.availability)) {
          return res.status(400).json({ message: "Invalid availability status" });
        }
        if (req.body.availability === "available" && item.status !== "approved") {
          return res.status(400).json({ message: "Only approved items can be made available" });
        }
        if (req.user.role === "vendor" && req.body.availability === "available" && (req.user.subscriptionPlan || "free") === "free") {
          const activeCount = store.data.menuItems.filter((entry) =>
            entry.id !== item.id &&
            entry.vendorId === req.user.id &&
            entry.status === "approved" &&
            entry.availability === "available"
          ).length;
          if (activeCount >= 3) {
            return res.status(402).json({ message: "The Free plan allows at most 3 active menu items. Upgrade to Premium or make another item unavailable." });
          }
        }
      }
      for (const key of allowed) if (Object.hasOwn(req.body, key)) item[key] = key === "price" ? Number(req.body[key]) : req.body[key];
      await store.persist();
      res.json({ item });
    } catch (error) { next(error); }
  });

  app.delete("/api/vendor/menu/:id", authenticate, authorize("vendor", "admin"), async (req, res, next) => {
    try {
      const index = store.data.menuItems.findIndex((entry) => entry.id === req.params.id);
      if (index === -1) return res.status(404).json({ message: "Menu item not found" });
      if (req.user.role === "vendor" && store.data.menuItems[index].vendorId !== req.user.id) return res.status(403).json({ message: "This item belongs to another vendor" });
      store.data.menuItems.splice(index, 1);
      await store.persist();
      res.status(204).end();
    } catch (error) { next(error); }
  });

  app.get("/api/admin/menu", authenticate, authorize("admin"), (req, res) => res.json({ items: store.data.menuItems }));

  app.patch("/api/admin/menu/:id", authenticate, authorize("admin"), async (req, res, next) => {
    try {
      const item = store.data.menuItems.find((entry) => entry.id === req.params.id);
      if (!item) return res.status(404).json({ message: "Menu item not found" });
      if (!["pending", "approved", "rejected"].includes(req.body.status)) return res.status(400).json({ message: "Invalid menu status" });
      item.status = req.body.status;
      if (item.status === "approved") {
        const vendor = store.data.users.find((entry) => entry.id === item.vendorId);
        const activeCount = store.data.menuItems.filter((entry) =>
          entry.id !== item.id &&
          entry.vendorId === item.vendorId &&
          entry.status === "approved" &&
          entry.availability === "available"
        ).length;
        item.availability = (vendor?.subscriptionPlan || "free") === "premium" || activeCount < 3
          ? "available"
          : "unavailable";
      }
      await store.persist();
      res.json({ item });
    } catch (error) { next(error); }
  });

  app.post("/api/orders", authenticate, authorize("customer"), async (req, res, next) => {
    try {
      const { itemId, deliveryDate, address, message = "" } = req.body;
      const item = store.data.menuItems.find((entry) => entry.id === itemId && entry.status === "approved" && entry.availability === "available");
      if (!item) return res.status(404).json({ message: "Menu item not found or not available" });
      const deliveryTimestamp = typeof deliveryDate === "string" ? Date.parse(deliveryDate) : NaN;
      if (!Number.isFinite(deliveryTimestamp) || deliveryTimestamp <= Date.now()) {
        return res.status(400).json({ message: "Choose a valid future delivery date and time" });
      }
      const deliveryAddress = String(address || "").trim();
      if (!deliveryAddress) return res.status(400).json({ message: "Delivery address is required" });
      if (item.vendorId === req.user.id) return res.status(400).json({ message: "Vendors cannot order their own menu items" });
      const duplicate = store.data.orders.find((entry) =>
        entry.customerId === req.user.id &&
        entry.itemId === itemId &&
        entry.deliveryDate === deliveryDate &&
        ["pending", "accepted"].includes(entry.status)
      );
      if (duplicate) return res.status(409).json({ message: "An active order already exists for this item and delivery date" });
      const now = new Date().toISOString();
      const order = { id: store.nextId("ord"), customerId: req.user.id, customerName: req.user.name, vendorId: item.vendorId, itemId: item.id, itemName: item.name, restaurant: item.vendor, deliveryDate: new Date(deliveryTimestamp).toISOString(), address: deliveryAddress, message: String(message).trim(), status: "pending", createdAt: now, timeline: [{ status: "pending", at: now }] };
      store.data.orders.push(order);
      await store.persist();
      res.status(201).json({ order });
    } catch (error) { next(error); }
  });

  app.get("/api/orders", authenticate, (req, res) => {
    const orders = req.user.role === "admin"
      ? store.data.orders
      : req.user.role === "vendor"
        ? store.data.orders.filter((order) => order.vendorId === req.user.id)
        : store.data.orders.filter((order) => order.customerId === req.user.id);
    res.json({ orders });
  });

  app.patch("/api/orders/:id/status", authenticate, authorize("vendor", "admin"), async (req, res, next) => {
    try {
      const order = store.data.orders.find((entry) => entry.id === req.params.id);
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (req.user.role === "vendor" && order.vendorId !== req.user.id) return res.status(403).json({ message: "This order belongs to another vendor" });
      const allowedStatuses = order.status === "pending"
        ? ["accepted", "rejected"]
        : order.status === "accepted"
          ? ["delivered"]
          : [];
      if (!allowedStatuses.includes(req.body.status)) {
        return res.status(400).json({ message: "Pending orders can be accepted or rejected; accepted orders can be marked delivered" });
      }
      order.status = req.body.status;
      order.timeline ||= [];
      if (!order.timeline.some((entry) => entry.status === req.body.status)) {
        order.timeline.push({ status: req.body.status, at: new Date().toISOString() });
      }
      if (req.body.status !== "delivered") {
        store.data.emailNotifications.push({
          id: store.nextId("email"),
          to: store.data.users.find((entry) => entry.id === order.customerId)?.email,
          subject: `Your PizzaHub order was ${req.body.status}`,
          orderId: order.id,
          status: req.body.status,
          createdAt: new Date().toISOString()
        });
      }
      await store.persist();
      res.json({ order });
    } catch (error) { next(error); }
  });

  app.delete("/api/orders/:id", authenticate, authorize("customer", "admin"), async (req, res, next) => {
    try {
      const index = store.data.orders.findIndex((entry) => entry.id === req.params.id);
      if (index === -1) return res.status(404).json({ message: "Order not found" });
      const order = store.data.orders[index];
      if (req.user.role === "customer" && (order.customerId !== req.user.id || order.status !== "pending")) return res.status(400).json({ message: "Only pending orders owned by you can be cancelled" });
      order.status = "cancelled";
      order.timeline ||= [];
      order.timeline.push({ status: "cancelled", at: new Date().toISOString() });
      await store.persist();
      res.json({ order });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/users", authenticate, authorize("admin"), (req, res) => {
    const { query, role } = req.query;
    let users = [...store.data.users];
    if (role) users = users.filter((user) => user.role === role);
    if (query) {
      const normalized = String(query).toLowerCase();
      users = users.filter((user) => user.name.toLowerCase().includes(normalized) || user.email.toLowerCase().includes(normalized));
    }
    res.json({ users: users.map(publicUser) });
  });

  app.patch("/api/admin/users/:id/status", authenticate, authorize("admin"), async (req, res, next) => {
    try {
      const user = store.data.users.find((entry) => entry.id === req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (!["active", "blocked"].includes(req.body.status)) return res.status(400).json({ message: "Invalid user status" });
      if (user.id === req.user.id && req.body.status === "blocked") {
        return res.status(400).json({ message: "You cannot block your own admin account" });
      }
      user.status = req.body.status;
      await store.persist();
      res.json({ user: publicUser(user) });
    } catch (error) { next(error); }
  });

  app.get("/api/admin/transactions", authenticate, authorize("admin"), (req, res) => res.json({ transactions: store.data.transactions }));

  app.post("/api/favorites/:itemId", authenticate, authorize("customer"), async (req, res, next) => {
    try {
      const item = store.data.menuItems.find((entry) => entry.id === req.params.itemId && entry.status === "approved");
      if (!item) return res.status(404).json({ message: "Menu item not found" });
      if (!store.data.favorites.some((entry) => entry.customerId === req.user.id && entry.itemId === item.id)) {
        store.data.favorites.push({ customerId: req.user.id, itemId: item.id, createdAt: new Date().toISOString() });
        await store.persist();
      }
      res.status(201).json({ favorite: true, item });
    } catch (error) { next(error); }
  });

  app.delete("/api/favorites/:itemId", authenticate, authorize("customer"), async (req, res, next) => {
    try {
      store.data.favorites = store.data.favorites.filter((entry) => !(entry.customerId === req.user.id && entry.itemId === req.params.itemId));
      await store.persist();
      res.json({ favorite: false });
    } catch (error) { next(error); }
  });

  app.get("/api/favorites", authenticate, authorize("customer"), (req, res) => {
    const ids = new Set(store.data.favorites.filter((entry) => entry.customerId === req.user.id).map((entry) => entry.itemId));
    res.json({ items: store.data.menuItems.filter((item) => ids.has(item.id) && item.status === "approved") });
  });

  app.get("/api/reviews/:itemId", (req, res) => {
    const reviews = store.data.reviews.filter((entry) => entry.itemId === req.params.itemId);
    const average = reviews.length ? reviews.reduce((sum, entry) => sum + entry.rating, 0) / reviews.length : null;
    res.json({ average, reviews });
  });

  app.post("/api/reviews/:itemId", authenticate, authorize("customer"), async (req, res, next) => {
    try {
      const item = store.data.menuItems.find((entry) => entry.id === req.params.itemId && entry.status === "approved");
      if (!item) return res.status(404).json({ message: "Menu item not found" });
      const rating = Number(req.body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ message: "Rating must be from 1 to 5" });
      const delivered = store.data.orders.some((entry) => entry.customerId === req.user.id && entry.itemId === item.id && ["accepted", "delivered"].includes(entry.status));
      if (!delivered) return res.status(403).json({ message: "Only customers with an active or completed order can review this item" });
      const existingIndex = store.data.reviews.findIndex((entry) => entry.customerId === req.user.id && entry.itemId === item.id);
      const review = { id: existingIndex >= 0 ? store.data.reviews[existingIndex].id : store.nextId("review"), itemId: item.id, customerId: req.user.id, customerName: req.user.name, rating, comment: String(req.body.comment || "").trim(), createdAt: new Date().toISOString() };
      if (existingIndex >= 0) store.data.reviews[existingIndex] = review;
      else store.data.reviews.push(review);
      await store.persist();
      res.status(existingIndex >= 0 ? 200 : 201).json({ review });
    } catch (error) { next(error); }
  });

  app.post("/api/vendor/subscription/checkout", authenticate, authorize("vendor"), (req, res) => {
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(503).json({ message: "Stripe Checkout is not configured. Set STRIPE_SECRET_KEY and STRIPE_PRICE_ID." });
    }
    res.status(501).json({ message: "Stripe Checkout is ready to configure with STRIPE_SECRET_KEY and STRIPE_PRICE_ID." });
  });

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), (req, res) => {
    if (!process.env.STRIPE_WEBHOOK_SECRET) return res.status(503).json({ message: "Stripe webhook secret is not configured" });
    res.status(501).json({ message: "Webhook verification is ready to configure." });
  });

  app.post("/api/vendor/profile/image", authenticate, authorize("vendor", "customer"), (req, res, next) => {
    profileImageUpload(req, res, (error) => {
      if (!error) return next();
      if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ message: "Image must be 5 MB or smaller" });
      }
      if (error.message === "Only image files are allowed") {
        return res.status(415).json({ message: error.message });
      }
      if (error instanceof multer.MulterError) {
        return res.status(400).json({ message: "Upload one image at a time" });
      }
      next(error);
    });
  }, async (req, res) => {
    if (!imgbbApiKey) return res.status(503).json({ message: "ImgBB is not configured. Set IMGBB_API_KEY." });
    if (!req.file) return res.status(400).json({ message: "Choose an image to upload" });
    if (!isSupportedImage(req.file)) {
      return res.status(415).json({ message: "Upload a valid PNG, JPEG, GIF, or WebP image" });
    }

    try {
      const image = await imageUploader(req.file, imgbbApiKey);
      req.user.image = image;
      await store.persist();
      res.status(201).json({ image, user: publicUser(req.user) });
    } catch (error) {
      console.error("ImgBB upload failed:", error.name);
      res.status(502).json({ message: "Image hosting is unavailable. Try again later." });
    }
  });

  app.use((req, res) => res.status(404).json({ message: "Route not found" }));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
