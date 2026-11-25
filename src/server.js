import { createApp } from "./app.js";
import { createAuth } from "./better-auth.js";
import { MongoClient } from "mongodb";
import { createStore } from "./store.js";

const port = Number(process.env.PORT || 3002);
const mongoUri = process.env.MONGODB_URI?.trim();
let store;
let auth;

if (mongoUri) {
  const client = new MongoClient(mongoUri);
  await client.connect();

  const database = client.db();
  store = await createStore(database);
  auth = createAuth({ database, client });
} else {
  store = await createStore();
  console.warn("MONGODB_URI is unset; using the local JSON store. Better Auth and Google sign-in are disabled.");
}

const app = await createApp({ store, auth });

app.listen(port, () => {
  console.log(`PizzaHub API listening on http://localhost:${port}`);
});
