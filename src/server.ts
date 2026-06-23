import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDb } from "./db/client.js";

const config = loadConfig();
const { db } = createDb(config.dbPath);
const app = createApp(db);

app.listen(config.port, () => {
  console.log(`CloudKitchen backend listening on http://localhost:${config.port}`);
});
