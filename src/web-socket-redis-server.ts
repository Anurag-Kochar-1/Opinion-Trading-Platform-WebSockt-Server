import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import { createClient, RedisClientType } from "redis";
import { Server } from "http";
import { RedisCredentials, SubscriptionMessage } from "./types";

let usersCount: number = 0;

export class WebSocketRedisServer {
  private app: express.Application;
  private httpServer: Server;
  private wss: WebSocketServer;
  private redisClient: RedisClientType;
  private redisPublisher: RedisClientType;
  private globalSubscriptions: Map<string, Set<WebSocket>>;
  private clientSubscriptions: WeakMap<WebSocket, Set<string>>;

  constructor(port: number, redisCredentials: RedisCredentials) {
    this.app = express();
    this.httpServer = this.app.listen(port);
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.redisClient = createClient(redisCredentials);
    this.redisPublisher = createClient(redisCredentials);

    this.globalSubscriptions = new Map();
    this.clientSubscriptions = new WeakMap();

    this.initializeWebSocketServer();
  }

  private initializeWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket) => {
      usersCount++;
      console.log(`👥 Client Connected, total users count is ${usersCount}`);
      this.clientSubscriptions.set(ws, new Set());

      ws.on("message", async (message: WebSocket.RawData) => {
        try {
          const data: SubscriptionMessage = JSON.parse(message.toString());
          await this.handleMessage(ws, data);
        } catch (error) {
          console.error("Error processing message:", error);
        }
      });

      ws.on("close", () => this.handleClientDisconnection(ws));
    });
  }

  private async handleMessage(
    ws: WebSocket,
    data: SubscriptionMessage
  ): Promise<void> {
    const { type, stockSymbol } = data;

    if (type === "subscribe") {
      await this.handleSubscription(ws, stockSymbol);
    } else if (type === "unsubscribe") {
      await this.handleUnsubscription(ws, stockSymbol);
    }
  }

  private async handleSubscription(
    ws: WebSocket,
    stockSymbol: string
  ): Promise<void> {
    const clientSubs = this.clientSubscriptions.get(ws)!;
    if (clientSubs.has(stockSymbol)) {
      console.log(`Client already subscribed to orderbook.${stockSymbol}`);
      return;
    }

    clientSubs.add(stockSymbol);

    if (!this.globalSubscriptions.has(stockSymbol)) {
      this.globalSubscriptions.set(stockSymbol, new Set([ws]));
      await this.redisClient.subscribe(
        `orderbook.${stockSymbol}`,
        (message) => {
          this.broadcastToSubscribers(stockSymbol, message);
        }
      );
      console.log(`Subscribed to orderbook.${stockSymbol}`);
    } else {
      this.globalSubscriptions.get(stockSymbol)!.add(ws);
      console.log(
        `Added client to existing subscription for orderbook.${stockSymbol}`
      );
    }
  }

  private async handleUnsubscription(
    ws: WebSocket,
    stockSymbol: string
  ): Promise<void> {
    const clientSubs = this.clientSubscriptions.get(ws)!;
    if (!clientSubs.has(stockSymbol)) {
      console.log(`Client not subscribed to orderbook.${stockSymbol}`);
      return;
    }

    clientSubs.delete(stockSymbol);

    const globalSubs = this.globalSubscriptions.get(stockSymbol)!;
    globalSubs.delete(ws);

    if (globalSubs.size === 0) {
      await this.redisClient.unsubscribe(`orderbook.${stockSymbol}`);
      this.globalSubscriptions.delete(stockSymbol);
      console.log(`Unsubscribed from orderbook.${stockSymbol}`);
    } else {
      console.log(
        `Removed client from subscription for orderbook.${stockSymbol}`
      );
    }
  }
  private broadcastToSubscribers(stockSymbol: string, message: string): void {
    const subscribers = this.globalSubscriptions.get(stockSymbol);
    if (subscribers) {
      const data = {
        event: "event_orderbook_update",
        stockSymbol,
        message,
      };
      subscribers.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
        }
      });
    }
  }

  private handleClientDisconnection(ws: WebSocket): void {
    console.log("Client disconnected");
    const clientSubs = this.clientSubscriptions.get(ws);
    if (clientSubs) {
      clientSubs.forEach((stockSymbol) => {
        this.handleUnsubscription(ws, stockSymbol);
      });
    }
    this.clientSubscriptions.delete(ws);
  }

  public async start(): Promise<void> {
    try {
      await this.redisClient.connect();
      await this.redisPublisher.connect();
      console.log("Connected to Redis");
    } catch (error) {
      console.error("Failed to connect to Redis", error);
    }
  }
}
