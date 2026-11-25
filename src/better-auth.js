import { mongodbAdapter } from "@better-auth/mongo-adapter";
import { betterAuth } from "better-auth";
import { parseTokenLifetime } from "./auth.js";

export function createAuth({ database, client }) {
  const secret = process.env.BETTER_AUTH_SECRET;
  const baseURL = process.env.BETTER_AUTH_URL;
  const googleClientId = process.env.GOOGLE_CLIENT_ID;
  const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;

  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET must be set to a secret of at least 32 characters");
  }
  if (!baseURL) {
    throw new Error("BETTER_AUTH_URL must be set to the API origin");
  }
  if ((process.env.CLIENT_ORIGIN || "").trim() === "*") {
    throw new Error("CLIENT_ORIGIN must be an explicit origin when Better Auth sessions are enabled");
  }
  if (Boolean(googleClientId) !== Boolean(googleClientSecret)) {
    throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must both be set");
  }

  const socialProviders = googleClientId && googleClientSecret
    ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
    : undefined;

  return betterAuth({
    database: mongodbAdapter(database, { client }),
    baseURL,
    basePath: "/api/better-auth",
    secret,
    trustedOrigins: (process.env.CLIENT_ORIGIN || "http://localhost:3000").split(",").map((origin) => origin.trim()),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 6,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: parseTokenLifetime(process.env.JWT_EXPIRES_IN || "7d") / 1000,
    },
    socialProviders,
    user: {
      additionalFields: {
        role: {
          type: "string",
          required: false,
          defaultValue: "customer",
          input: true,
        },
      },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => ({
            data: {
              ...user,
              role: user.role === "vendor" ? "vendor" : "customer",
            },
          }),
        },
      },
    },
  });
}
