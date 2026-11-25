import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../data");
const dataFile = path.join(directory, "database.json");

const seed = {
  users: [
    { id: "usr-admin", name: "PizzaHub Admin", email: "admin@pizzahub.example", passwordHash: "", role: "admin", status: "active", createdAt: "2025-11-01T12:00:00.000Z" },
    { id: "usr-vendor", name: "Little Oven Pizzeria", email: "hello@littleoven.example", passwordHash: "", role: "vendor", status: "active", businessName: "Little Oven Pizzeria", subscriptionPlan: "free", createdAt: "2025-11-02T12:00:00.000Z" },
    { id: "usr-customer", name: "Jamie Rivera", email: "jamie@example.com", passwordHash: "", role: "customer", status: "active", createdAt: "2025-11-03T12:00:00.000Z" }
  ],
  menuItems: [
    { id: "classic-margherita", name: "The Classic Margherita", category: "Classic", description: "San Marzano tomato, creamy mozzarella, fresh basil.", price: 14.5, rating: "4.9", time: "20-25 min", tag: "Bestseller", location: "Downtown", vendor: "Little Oven Pizzeria", vendorId: "usr-vendor", image: "https://images.unsplash.com/photo-1579751626657-72bc17010498?auto=format&fit=crop&w=900&q=85", status: "approved", availability: "available" },
    { id: "garden-party", name: "Garden Party", category: "Veggie", description: "Roasted peppers, red onion, olives, and basil pesto.", price: 16, rating: "4.8", time: "25-30 min", tag: "Vegetarian", location: "Riverside", vendor: "Greenhouse Pizza Co.", vendorId: "usr-vendor", image: "https://images.unsplash.com/photo-1571407970349-bc81e7e96d47?auto=format&fit=crop&w=900&q=85", status: "approved", availability: "available" },
    { id: "smoky-pepperoni", name: "Smoky Pepperoni", category: "Meat", description: "Cup-and-char pepperoni, hot honey, aged parmesan.", price: 18.5, rating: "5.0", time: "20-25 min", tag: "Fan favorite", location: "Northside", vendor: "Brick & Basil", vendorId: "usr-vendor", image: "https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&w=900&q=85", status: "pending", availability: "unavailable" }
  ],
  orders: [
    { id: "ord-001", customerId: "usr-customer", customerName: "Jamie R.", vendorId: "usr-vendor", itemId: "smoky-pepperoni", itemName: "Smoky Pepperoni", restaurant: "Brick & Basil", deliveryDate: "Nov 20, 7:00 PM", address: "Northside", status: "pending", createdAt: "2025-11-18T12:00:00.000Z" }
  ],
  transactions: [
    { id: "txn-001", restaurant: "Brick & Basil", plan: "Premium", amount: 19, date: "Nov 18, 2025", status: "succeeded" },
    { id: "txn-002", restaurant: "Greenhouse Pizza Co.", plan: "Premium", amount: 19, date: "Nov 17, 2025", status: "pending" },
    { id: "txn-003", restaurant: "Little Oven Pizzeria", plan: "Premium", amount: 19, date: "Nov 16, 2025", status: "failed" }
  ]
};

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, encoded) {
  if (!encoded) return password === "password";
  const [algorithm, salt, hash] = encoded.split(":");
  if (algorithm !== "scrypt") return false;
  const candidate = crypto.scryptSync(password, salt, 64).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(candidate, "hex"));
}

export async function createStore() {
  await mkdir(directory, { recursive: true });
  let state;
  try {
    state = JSON.parse(await readFile(dataFile, "utf8"));
  } catch {
    state = structuredClone(seed);
    for (const user of state.users) user.passwordHash = hashPassword("password");
    await writeFile(dataFile, JSON.stringify(state, null, 2));
  }

  const persist = async () => {
    await writeFile(dataFile, JSON.stringify(state, null, 2));
  };

  return {
    data: state,
    persist,
    nextId(prefix) {
      return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    }
  };
}
