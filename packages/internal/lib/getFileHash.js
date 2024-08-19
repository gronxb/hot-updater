"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getFileHashFromFile = exports.getFileHashFromUrl = void 0;
const node_crypto_1 = __importDefault(require("node:crypto"));
const promises_1 = __importDefault(require("node:fs/promises"));
function getFileHashFromUrl(url) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Fetch the file
            const response = yield fetch(url);
            if (!response.ok)
                throw new Error(`Failed to fetch ${url}: ${response.statusText}`);
            // Get the file as a buffer
            const buffer = yield response.arrayBuffer();
            const fileBuffer = Buffer.from(buffer);
            // Calculate the hash
            const hash = node_crypto_1.default.createHash("sha256");
            hash.update(fileBuffer);
            const fileHash = hash.digest("hex");
            return fileHash;
        }
        catch (error) {
            console.error("Error fetching or processing the file:", error);
            throw error;
        }
    });
}
exports.getFileHashFromUrl = getFileHashFromUrl;
function getFileHashFromFile(filepath) {
    return __awaiter(this, void 0, void 0, function* () {
        try {
            // Read the file
            const fileBuffer = yield promises_1.default.readFile(filepath).catch((error) => {
                console.error("Error reading the file:", error);
                throw error;
            });
            // Calculate the hash
            const hash = node_crypto_1.default.createHash("sha256");
            hash.update(fileBuffer);
            const fileHash = hash.digest("hex");
            return fileHash;
        }
        catch (error) {
            console.error("Error fetching or processing the file:", error);
            throw error;
        }
    });
}
exports.getFileHashFromFile = getFileHashFromFile;
//# sourceMappingURL=getFileHash.js.map