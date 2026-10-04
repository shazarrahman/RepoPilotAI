import { randomBytes, scrypt as callback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(callback);
export async function hashPassword(value: string) { const salt = randomBytes(16).toString("hex"); return `${salt}:${((await scrypt(value, salt, 64)) as Buffer).toString("hex")}`; }
export async function verifyPassword(value: string, stored: string) { const [salt, hash] = stored.split(":"); if (!salt || !hash) return false; return timingSafeEqual((await scrypt(value, salt, 64)) as Buffer, Buffer.from(hash, "hex")); }
