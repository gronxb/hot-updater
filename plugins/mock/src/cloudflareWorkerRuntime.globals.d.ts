declare global {
  interface D1Database {
    prepare(...args: any[]): any;
  }

  interface R2Bucket {
    get(key: string): Promise<any>;
  }
}

export {};
