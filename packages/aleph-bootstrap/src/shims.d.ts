declare module "@libp2p/bootstrap" {
  export function bootstrap(options: {
    list?: string[];
    timeout?: number;
    tagName?: string;
  }): unknown;
}
