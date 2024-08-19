export declare const encryptJson: (jsonData: Record<string, any>, secretKey: string) => string;
export declare const decryptJson: <T>(encryptedData: string, secretKey: string) => T;
