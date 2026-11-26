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
    { id: "smoky-pepperoni", name: "Smoky Pepperoni", category: "Meat", description: "Cup-and-char pepperoni, hot honey, aged parmesan.", price: 18.5, rating: "5.0", time: "20-25 min", tag: "Fan favorite", location: "Northside", vendor: "Brick & Basil", vendorId: "usr-vendor", image: "https://images.unsplash.com/photo-1628840042765-356cda07504e?auto=format&fit=crop&w=900&q=85", status: "pending", availability: "unavailable" },
    { id: "demo-four-cheese", name: "Four Cheese Classic", category: "Classic", description: "Mozzarella, provolone, parmesan, and a golden cheese crust.", price: 16, rating: "4.8", time: "20-25 min", tag: "Demo favorite", location: "Downtown", vendor: "Little Oven Pizzeria", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/5903382/pexels-photo-5903382.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-garden-pesto", name: "Garden Pesto Pizza", category: "Veggie", description: "Fresh basil pesto, ripe tomatoes, mozzarella, and garden greens.", price: 15.5, rating: "4.9", time: "25-30 min", tag: "Vegetarian", location: "Riverside", vendor: "Greenhouse Pizza Co.", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/31596394/pexels-photo-31596394.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-pepperoni-party", name: "Pepperoni Party", category: "Meat", description: "Classic pepperoni, bubbling mozzarella, and house tomato sauce.", price: 17.5, rating: "4.9", time: "20-25 min", tag: "Bestseller", location: "Northside", vendor: "Brick & Basil", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/31587831/pexels-photo-31587831.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-harvest-pizza", name: "Harvest Veggie", category: "Veggie", description: "Roasted seasonal vegetables, herbs, and creamy mozzarella.", price: 16.25, rating: "4.7", time: "25-30 min", tag: "Fresh pick", location: "Riverside", vendor: "Greenhouse Pizza Co.", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/32763320/pexels-photo-32763320.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-hot-honey", name: "Hot Honey Pepperoni", category: "Meat", description: "Charred pepperoni finished with sweet heat and fresh herbs.", price: 18, rating: "5.0", time: "20-25 min", tag: "Fan favorite", location: "Downtown", vendor: "Brick & Basil", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/6068717/pexels-photo-6068717.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-mushroom-pizza", name: "Woodland Mushroom", category: "Veggie", description: "Roasted mushrooms, black olives, thyme, and aged parmesan.", price: 16.75, rating: "4.8", time: "25-30 min", tag: "Vegetarian", location: "Old Town", vendor: "Greenhouse Pizza Co.", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/5903315/pexels-photo-5903315.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-double-smash", name: "Double Smash Burger", category: "Meat", description: "Two seared beef patties, cheddar, pickles, and burger sauce.", price: 14.5, rating: "4.9", time: "20-25 min", tag: "Demo favorite", location: "Downtown", vendor: "Burger Barn", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/36007382/pexels-photo-36007382.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-bbq-bacon", name: "BBQ Bacon Stack", category: "Meat", description: "Smoky barbecue glaze, crisp bacon, cheddar, and onion.", price: 16, rating: "4.8", time: "25-30 min", tag: "House special", location: "Northside", vendor: "Burger Barn", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/15010285/pexels-photo-15010285.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-greenhouse-burger", name: "Greenhouse Veggie Burger", category: "Veggie", description: "A crisp plant-based patty with lettuce, tomato, and herb mayo.", price: 14, rating: "4.7", time: "20-25 min", tag: "Vegetarian", location: "Riverside", vendor: "Greenhouse Pizza Co.", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/5374420/pexels-photo-5374420.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-cheddar-melt", name: "Cheddar Melt Burger", category: "Meat", description: "Juicy grilled beef, melted cheddar, lettuce, and tomato.", price: 15.5, rating: "4.8", time: "20-25 min", tag: "Customer pick", location: "Old Town", vendor: "Burger Barn", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/33502810/pexels-photo-33502810.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-slider-trio", name: "Mini Slider Trio", category: "Meat", description: "Three bite-size beef sliders with crisp lettuce and house sauce.", price: 13.5, rating: "4.6", time: "20-25 min", tag: "Perfect to share", location: "Downtown", vendor: "Burger Barn", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/40294660/pexels-photo-40294660.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" },
    { id: "demo-market-burger", name: "Market Street Burger", category: "Meat", description: "A grilled burger topped with fresh greens and market vegetables.", price: 16.5, rating: "4.8", time: "25-30 min", tag: "Fresh pick", location: "Riverside", vendor: "Burger Barn", vendorId: "usr-vendor", image: "https://images.pexels.com/photos/2299981/pexels-photo-2299981.jpeg?auto=compress&cs=tinysrgb&w=900", status: "approved", availability: "available" }
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

export const demoMenuItems = seed.menuItems.slice(3);

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

async function loadFileState() {
  await mkdir(directory, { recursive: true });
  try {
    return JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    const state = structuredClone(seed);
    for (const user of state.users) user.passwordHash = hashPassword("password");
    await writeFile(dataFile, JSON.stringify(state, null, 2));
    return state;
  }
}

export async function createStore(database) {
  const collection = database?.collection("pizzaHubAppState");
  const savedState = collection ? await collection.findOne({ _id: "main" }) : null;
  const state = savedState?.data || await loadFileState();
  const persist = collection
    ? async () => collection.updateOne({ _id: "main" }, { $set: { data: state } }, { upsert: true })
    : async () => writeFile(dataFile, JSON.stringify(state, null, 2));

  if (collection && !savedState) {
    await collection.insertOne({ _id: "main", data: state });
  }

  return {
    data: state,
    persist,
    nextId(prefix) {
      return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
    }
  };
}
