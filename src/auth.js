import crypto from "node:crypto";

export function parseTokenLifetime(value) {
  const match = /^([1-9]\d*)(s|m|h|d)$/.exec(value);
  if (!match) throw new Error("JWT_EXPIRES_IN must be a positive duration such as 30m or 7d");

  const units = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
  const milliseconds = Number(match[1]) * units[match[2]];
  if (!Number.isSafeInteger(milliseconds)) throw new Error("JWT_EXPIRES_IN is too large");
  return milliseconds;
}

export function createToken(user, secret, lifetime = process.env.JWT_EXPIRES_IN || "7d") {
  const payload = Buffer.from(JSON.stringify({
    sub: user.id,
    role: user.role,
    exp: Date.now() + parseTokenLifetime(lifetime)
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyToken(token, secret) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  if (signature.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}
