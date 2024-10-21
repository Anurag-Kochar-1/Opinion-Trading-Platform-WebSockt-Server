import { WebSocketRedisServer } from "./web-socket-redis-server";
import { PORT, REDIS_CREDENTIALS } from "./config";

const server = new WebSocketRedisServer(PORT, REDIS_CREDENTIALS);
server.start().catch(console.error);
