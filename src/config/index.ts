import dotenv from "dotenv";
import { RedisCredentials } from "../types";

dotenv.config();

export const PORT = process.env.WS_PORT ? parseInt(process.env.WS_PORT, 10) : 5000;

export const REDIS_CREDENTIALS: RedisCredentials = {
  url: process.env.REDIS_URL || "",
  username: process.env.REDIS_USERNAME || "",
  password: process.env.REDIS_PASSWORD || "",
};
