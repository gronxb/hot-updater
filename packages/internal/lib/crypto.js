"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.decryptJson = exports.encryptJson = void 0;
const crypto_1 = __importDefault(require("crypto"));
const isObject_1 = require("./isObject");
const encryptJson = (jsonData, secretKey) => {
    if ((0, isObject_1.isObject)(jsonData) === false) {
        throw new Error("jsonData must be an object");
    }
    const iv = crypto_1.default.randomBytes(16);
    const cipher = crypto_1.default.createCipheriv("aes-256-cbc", Buffer.from(secretKey, "hex"), iv);
    let encrypted = cipher.update(JSON.stringify(jsonData));
    encrypted = Buffer.concat([encrypted, cipher.final()]);
    return [iv.toString("hex"), encrypted.toString("hex")].join(":");
};
exports.encryptJson = encryptJson;
const decryptJson = (encryptedData, secretKey) => {
    const parts = encryptedData.split(":");
    const iv = Buffer.from(parts[0], "hex");
    const encryptedText = Buffer.from(parts[1], "hex");
    const decipher = crypto_1.default.createDecipheriv("aes-256-cbc", Buffer.from(secretKey, "hex"), iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return JSON.parse(decrypted.toString());
};
exports.decryptJson = decryptJson;
//# sourceMappingURL=crypto.js.map