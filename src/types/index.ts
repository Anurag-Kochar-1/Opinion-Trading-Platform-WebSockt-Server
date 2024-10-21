export interface SubscriptionMessage {
  type: "subscribe" | "unsubscribe";
  stockSymbol: string;
}

export interface RedisCredentials {
  url: string;
  username: string;
  password: string;
}
