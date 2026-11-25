import { createApp } from "./app.js";

const port = Number(process.env.PORT || 3002);
const app = await createApp();

app.listen(port, () => {
  console.log(`PizzaHub API listening on http://localhost:${port}`);
});
