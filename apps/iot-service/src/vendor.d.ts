declare module "nodes7" {
  interface ConnectionOptions {
    host: string;
    port: number;
    rack?: number;
    slot?: number;
    timeout?: number;
  }
  export default class NodeS7 {
    initiateConnection(options: ConnectionOptions, callback: (error?: unknown) => void): void;
    dropConnection(callback?: () => void): void;
    setTranslationCB(callback: (tag: string) => string): void;
    addItems(items: string | string[]): void;
    removeItems(items?: string | string[]): void;
    writeItems(items: string | string[], values: unknown, callback: (anythingBad: unknown) => void): number | void;
    readAllItems(callback: (anythingBad: unknown, values: Record<string, unknown>) => void): void;
  }
}

declare module "mcprotocol" {
  interface ConnectionOptions {
    host: string;
    port: number;
    ascii: boolean;
    octalInputOutput?: boolean;
  }
  export default class McProtocol {
    initiateConnection(options: ConnectionOptions, callback: (error?: unknown) => void): void;
    dropConnection(callback?: () => void): void;
    setTranslationCB(callback: (tag: string) => string): void;
    addItems(items: string | string[]): void;
    removeItems(items?: string | string[]): void;
    writeItems(items: string | string[], values: unknown, callback: (anythingBad: unknown) => void): number | void;
    readAllItems(callback: (anythingBad: unknown, values: Record<string, unknown>) => void): void;
  }
}
