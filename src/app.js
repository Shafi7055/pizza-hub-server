import express from "express";
import cors from "cors";
import multer from "multer";
import Stripe from "stripe";
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
  const stripeClient = options.stripeClient ?? (process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null);
  const stripePriceId = options.stripePriceId ?? process.env.STRIPE_PRICE_ID;
  const stripeWebhookSecret = options.stripeWebhookSecret ?? process.env.STRIPE_WEBHOOK_SECRET;
  const secret = options.tokenSecret || process.env.JWT_SECRET || process.env.TOKEN_SECRET || "development-only-secret";
  const allowedOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
  const clientOrigin = allowedOrigin.split(",")[0].trim();
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
  store.data.processedStripeEvents ||= [];

  app.use(cors({
    origin: allowedOrigin === "*" ? "*" : allowedOrigin.split(",").map((value) => value.trim()),
    credentials: true,
  }));
  if (auth) app.all("/api/better-auth/*", toNodeHandler(auth));

  function stripeObjectId(value) {
    return typeof value === "string" ? value : value?.id || null;
  }

  function recordStripeTransaction({ vendor, sessionId, invoiceId, amount, currency, status, created }) {
    let transaction = store.data.transactions.find((entry) =>
      (invoiceId && entry.stripeInvoiceId === invoiceId) ||
      (sessionId && entry.stripeSessionId === sessionId)
    );
    const values = {
      id: transaction?.id || store.nextId("txn"),
      vendorId: vendor.id,
      restaurant: vendor.businessName || vendor.name,
      plan: "Premium",
      amount: Number(amount || 0) / 100,
      currency: String(currency || "usd").toUpperCase(),
      date: Number.isFinite(created) ? new Date(created * 1000).toISOString() : new Date().toISOString(),
      status,
      ...(sessionId ? { stripeSessionId: sessionId } : {}),
      ...(invoiceId ? { stripeInvoiceId: invoiceId } : {}),
    };
    if (transaction) Object.assign(transaction, values);
    else {
      transaction = values;
      store.data.transactions.push(transaction);
    }
  }

  function updateVendorSubscription(vendor, subscription, fallbackStatus) {
    const status = subscription.status || fallbackStatus;
    vendor.stripeCustomerId = stripeObjectId(subscription.customer) || vendor.stripeCustomerId;
    vendor.stripeSubscriptionId = stripeObjectId(subscription.id) || vendor.stripeSubscriptionId;
    vendor.subscriptionStatus = status;
    if (["active", "trialing", "past_due"].includes(status)) {
      vendor.subscriptionPlan = "premium";
    } else if (["canceled", "unpaid", "incomplete_expired"].includes(status)) {
      vendor.subscriptionPlan = "free";
    }
    if (Number.isFinite(subscription.current_period_end)) {
      vendor.subscriptionCurrentPeriodEnd = new Date(subscription.current_period_end * 1000).toISOString();
    }
  }

  async function findStripeVendor({ vendorId, subscriptionId, customerId }) {
    let vendor = store.data.users.find((entry) => entry.id === vendorId && entry.role === "vendor");
    if (!vendor && subscriptionId) {
      vendor = store.data.users.find((entry) => entry.role === "vendor" && entry.stripeSubscriptionId === subscriptionId);
    }
    if (!vendor && customerId) {
      vendor = store.data.users.find((entry) => entry.role === "vendor" && entry.stripeCustomerId === customerId);
    }
    if (!vendor && stripeClient && subscriptionId) {
      const subscription = await stripeClient.subscriptions.retrieve(subscriptionId);
      vendor = store.data.users.find((entry) =>
        entry.id === subscription.metadata?.vendorId && entry.role === "vendor"
      );
    }
    return vendor;
  }

  async function processStripeEvent(event) {
    const data = event.data.object;
    if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded" || event.type === "checkout.session.async_payment_failed") {
      if (data.mode !== "subscription") return;
      const vendor = await findStripeVendor({
        vendorId: data.metadata?.vendorId || data.client_reference_id,
        subscriptionId: stripeObjectId(data.subscription),
        customerId: stripeObjectId(data.customer),
      });
      if (!vendor) throw new Error(`Stripe Checkout session ${data.id} does not match a vendor`);

      const succeeded = event.type === "checkout.session.async_payment_succeeded" ||
        (event.type === "checkout.session.completed" && ["paid", "no_payment_required"].includes(data.payment_status));
      const failed = event.type === "checkout.session.async_payment_failed";
      if (succeeded) {
        updateVendorSubscription(vendor, {
          id: stripeObjectId(data.subscription),
          customer: stripeObjectId(data.customer),
          status: "active",
        }, "active");
      } else {
        vendor.stripeCustomerId = stripeObjectId(data.customer) || vendor.stripeCustomerId;
        vendor.stripeSubscriptionId = stripeObjectId(data.subscription) || vendor.stripeSubscriptionId;
        if (!vendor.subscriptionStatus || vendor.subscriptionStatus === "pending") {
          vendor.subscriptionStatus = failed ? "incomplete_expired" : "pending";
        }
        if (failed && vendor.subscriptionPlan !== "premium") vendor.subscriptionPlan = "free";
      }

      recordStripeTransaction({
        vendor,
        sessionId: data.id,
        amount: data.amount_total,
        currency: data.currency,
        status: succeeded ? "succeeded" : failed ? "failed" : "pending",
        created: data.created,
      });
      return;
    }

    if (event.type === "customer.subscription.created" || event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const subscription = data;
      const vendor = await findStripeVendor({
        vendorId: subscription.metadata?.vendorId,
        subscriptionId: stripeObjectId(subscription.id),
        customerId: stripeObjectId(subscription.customer),
      });
      if (!vendor) throw new Error(`Stripe subscription ${subscription.id} does not match a vendor`);
      updateVendorSubscription(vendor, subscription, event.type === "customer.subscription.deleted" ? "canceled" : undefined);
      return;
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = data;
      const subscriptionId = stripeObjectId(invoice.subscription) ||
        stripeObjectId(invoice.parent?.subscription_details?.subscription);
      if (event.type === "invoice.paid" && invoice.billing_reason === "subscription_create") return;
      const vendor = await findStripeVendor({
        subscriptionId,
        customerId: stripeObjectId(invoice.customer),
      });
      if (!vendor) throw new Error(`Stripe invoice ${invoice.id} does not match a vendor`);
      if (event.type === "invoice.paid") {
        vendor.subscriptionStatus = "active";
        vendor.subscriptionPlan = "premium";
      } else {
        vendor.subscriptionStatus = "past_due";
      }
      recordStripeTransaction({
        vendor,
        invoiceId: invoice.id,
        amount: event.type === "invoice.paid" ? invoice.amount_paid : invoice.amount_due,
        currency: invoice.currency,
        status: event.type === "invoice.paid" ? "succeeded" : "failed",
        created: invoice.created,
      });
    }
  }

  app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res, next) => {
    if (!stripeClient || !stripeWebhookSecret) {
      return res.status(503).json({ message: "Stripe webhook is not configured. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET." });
    }
    let event;
    try {
      event = stripeClient.webhooks.constructEvent(req.body, req.headers["stripe-signature"], stripeWebhookSecret);
    } catch {
      return res.status(400).json({ message: "Invalid Stripe webhook signature" });
    }
    if (store.data.processedStripeEvents.includes(event.id)) return res.json({ received: true, duplicate: true });

    try {
      await processStripeEvent(event);
      store.data.processedStripeEvents.push(event.id);
      await store.persist();
      res.json({ received: true });
    } catch (error) {
      next(error);
    }
  });

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

  app.post("/api/orders/checkout", authenticate, authorize("customer"), async (req, res, next) => {
    try {
      const { items, deliveryDate, address, message = "" } = req.body;
      if (!Array.isArray(items) || items.length === 0 || items.length > 50) {
        return res.status(400).json({ message: "Add between 1 and 50 menu items to your cart" });
      }

      const deliveryTimestamp = typeof deliveryDate === "string" ? Date.parse(deliveryDate) : NaN;
      if (!Number.isFinite(deliveryTimestamp) || deliveryTimestamp <= Date.now()) {
        return res.status(400).json({ message: "Choose a valid future delivery date and time" });
      }
      const deliveryAddress = String(address || "").trim();
      if (!deliveryAddress) return res.status(400).json({ message: "Delivery address is required" });

      const seenItemIds = new Set();
      const orderLines = [];
      for (const line of items) {
        const itemId = typeof line?.itemId === "string" ? line.itemId : "";
        const quantity = Number(line?.quantity);
        if (!itemId || seenItemIds.has(itemId) || !Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
          return res.status(400).json({ message: "Cart items must have unique menu IDs and quantities from 1 to 99" });
        }
        seenItemIds.add(itemId);

        const item = store.data.menuItems.find((entry) =>
          entry.id === itemId && entry.status === "approved" && entry.availability === "available"
        );
        if (!item) return res.status(404).json({ message: "A menu item in your cart is no longer available" });
        if (item.vendorId === req.user.id) return res.status(400).json({ message: "Vendors cannot order their own menu items" });
        orderLines.push({ item, quantity });
      }

      const canonicalDeliveryDate = new Date(deliveryTimestamp).toISOString();
      const duplicate = orderLines.some(({ item }) => store.data.orders.some((entry) =>
        entry.customerId === req.user.id &&
        entry.itemId === item.id &&
        entry.deliveryDate === canonicalDeliveryDate &&
        ["pending", "accepted"].includes(entry.status)
      ));
      if (duplicate) return res.status(409).json({ message: "An active order already exists for a cart item and delivery date" });

      const now = new Date().toISOString();
      const orders = orderLines.map(({ item, quantity }) => ({
        id: store.nextId("ord"),
        customerId: req.user.id,
        customerName: req.user.name,
        vendorId: item.vendorId,
        itemId: item.id,
        itemName: item.name,
        restaurant: item.vendor,
        quantity,
        unitPrice: Number(item.price),
        totalAmount: Number((Number(item.price) * quantity).toFixed(2)),
        deliveryDate: canonicalDeliveryDate,
        address: deliveryAddress,
        message: String(message).trim(),
        status: "pending",
        createdAt: now,
        timeline: [{ status: "pending", at: now }],
      }));
      store.data.orders.push(...orders);
      await store.persist();
      res.status(201).json({ orders });
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
    const item = store.data.menuItems.find((entry) => entry.id === req.params.itemId);
    const restaurantItemIds = new Set(
      store.data.menuItems
        .filter((entry) => item && entry.vendorId === item.vendorId)
        .map((entry) => entry.id)
    );
    const restaurantReviews = store.data.reviews.filter((entry) => restaurantItemIds.has(entry.itemId));
    const restaurantAverage = restaurantReviews.length
      ? restaurantReviews.reduce((sum, entry) => sum + entry.rating, 0) / restaurantReviews.length
      : null;
    res.json({
      average,
      reviews,
      restaurantAverage,
      restaurantReviewCount: restaurantReviews.length
    });
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
      const review = { id: existingIndex >= 0 ? store.data.reviews[existingIndex].id : store.nextId("review"), itemId: item.id, vendorId: item.vendorId, customerId: req.user.id, customerName: req.user.name, rating, comment: String(req.body.comment || "").trim(), createdAt: new Date().toISOString() };
      if (existingIndex >= 0) store.data.reviews[existingIndex] = review;
      else store.data.reviews.push(review);
      await store.persist();
      res.status(existingIndex >= 0 ? 200 : 201).json({ review });
    } catch (error) { next(error); }
  });

  app.post("/api/vendor/subscription/checkout", authenticate, authorize("vendor"), async (req, res, next) => {
    if (!stripeClient || !stripePriceId || !stripeWebhookSecret) {
      return res.status(503).json({ message: "Stripe Checkout is not fully configured. Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID, and STRIPE_WEBHOOK_SECRET." });
    }
    if (req.user.subscriptionPlan === "premium" && ["active", "trialing", "past_due"].includes(req.user.subscriptionStatus)) {
      return res.status(409).json({ message: "Your Premium subscription is already active." });
    }

    try {
      const session = await stripeClient.checkout.sessions.create({
        mode: "subscription",
        line_items: [{ price: stripePriceId, quantity: 1 }],
        success_url: `${clientOrigin}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientOrigin}/payment/cancel`,
        client_reference_id: req.user.id,
        metadata: { vendorId: req.user.id },
        subscription_data: { metadata: { vendorId: req.user.id } },
        ...(req.user.stripeCustomerId
          ? { customer: req.user.stripeCustomerId }
          : { customer_email: req.user.email }),
      });
      if (!session.url) throw new Error("Stripe did not return a Checkout URL");
      res.json({ url: session.url });
    } catch (error) {
      next(error);
    }
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
      const message = error instanceof Error ? error.message : "ImgBB upload failed";
      console.error("ImgBB upload failed:", message);
      res.status(502).json({ message });
    }
  });

  app.use((req, res) => res.status(404).json({ message: "Route not found" }));
  app.use((error, req, res, next) => {
    console.error(error);
    res.status(500).json({ message: "Internal server error" });
  });

  return app;
}
