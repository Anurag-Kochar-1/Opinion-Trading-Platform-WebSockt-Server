import WebSocket, { WebSocketServer } from "ws";
import express from "express";
import { createClient, RedisClientType } from "redis";
import { Server } from "http";
import { RedisCredentials, SubscriptionMessage } from "./types";
import { logger } from "./config/logger";

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

    logger.info('WebSocket server initialized', { port });
    this.initializeWebSocketServer();
  }

  private initializeWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket, req: any) => {
      usersCount++;

      logger.info('Client connected', {
        usersCount,
        ip: req.socket.remoteAddress,
        userAgent: req.headers['user-agent']
      });

      this.clientSubscriptions.set(ws, new Set());

      ws.on("message", async (message: WebSocket.RawData) => {
        try {
          const data: SubscriptionMessage = JSON.parse(message.toString());
          await this.handleMessage(ws, data);
          logger.debug('Message received', {
            type: data.type,
            stockSymbol: data.stockSymbol
          });
        } catch (error) {
          logger.error('Error processing message', {
            error: error instanceof Error ? error.message : 'Unknown error',
            raw: message.toString().substring(0, 200)
          });
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
    } else {
      logger.warn('Unknown message type received', { type, stockSymbol });
    }
  }

  private async handleSubscription(
    ws: WebSocket,
    stockSymbol: string
  ): Promise<void> {
    const clientSubs = this.clientSubscriptions.get(ws)!;
    if (clientSubs.has(stockSymbol)) {
      logger.debug('Duplicate subscription attempt', { stockSymbol });
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
      logger.info('New stock subscription created', {
        stockSymbol,
        subscribersCount: 1
      });

    } else {
      this.globalSubscriptions.get(stockSymbol)!.add(ws);
      logger.info('Client added to existing subscription', {
        stockSymbol,
        subscribersCount: this.globalSubscriptions.get(stockSymbol)!.size
      });
    }
  }

  private async handleUnsubscription(
    ws: WebSocket,
    stockSymbol: string
  ): Promise<void> {
    const clientSubs = this.clientSubscriptions.get(ws)!;
    if (!clientSubs.has(stockSymbol)) {
      logger.debug('Unsubscribe attempt for non-subscribed stock', { stockSymbol });
      return;
    }

    clientSubs.delete(stockSymbol);

    const globalSubs = this.globalSubscriptions.get(stockSymbol)!;
    globalSubs.delete(ws);

    if (globalSubs.size === 0) {
      await this.redisClient.unsubscribe(`orderbook.${stockSymbol}`);
      this.globalSubscriptions.delete(stockSymbol);
      logger.info('Stock subscription removed', { stockSymbol });
    } else {
      logger.info('Client removed from subscription', {
        stockSymbol,
        remainingSubscribers: globalSubs.size
      });

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
      let successCount = 0;
      let failCount = 0;

      subscribers.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify(data));
          successCount++
        } else {
          failCount++;
        }
      });
      logger.debug('Broadcast completed', {
        stockSymbol,
        successCount,
        failCount,
        totalSubscribers: subscribers.size
      });

    }
  }

  private handleClientDisconnection(ws: WebSocket): void {
    usersCount--
    logger.info('Client disconnected', {
      remainingUsers: usersCount,
      subscriptionsCount: this.clientSubscriptions.get(ws)?.size || 0
    });
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
      logger.info('Redis connections established');
    } catch (error) {
      logger.error('Failed to connect to Redis', {
        error: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined
      });
      throw error;
    }
  }
}
