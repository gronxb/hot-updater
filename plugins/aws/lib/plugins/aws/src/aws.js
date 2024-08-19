var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __rest = (this && this.__rest) || function (s, e) {
    var t = {};
    for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p) && e.indexOf(p) < 0)
        t[p] = s[p];
    if (s != null && typeof Object.getOwnPropertySymbols === "function")
        for (var i = 0, p = Object.getOwnPropertySymbols(s); i < p.length; i++) {
            if (e.indexOf(p[i]) < 0 && Object.prototype.propertyIsEnumerable.call(s, p[i]))
                t[p[i]] = s[p[i]];
        }
    return t;
};
import path from "path";
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, S3Client, } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import fs from "fs/promises";
import mime from "mime";
import { streamToString } from "./utils/streamToString";
export const aws = (config) => ({ log, spinner }) => {
    const { bucketName } = config, s3Config = __rest(config, ["bucketName"]);
    const client = new S3Client(s3Config);
    let updateSources = [];
    return {
        commitUpdateJson() {
            return __awaiter(this, void 0, void 0, function* () {
                var _a;
                try {
                    const command = new GetObjectCommand({
                        Bucket: bucketName,
                        Key: "update.json",
                    });
                    yield client.send(command);
                }
                catch (e) {
                    if (e instanceof NoSuchKey) {
                        spinner === null || spinner === void 0 ? void 0 : spinner.message("Creating new update.json");
                    }
                    else {
                        throw e;
                    }
                }
                spinner === null || spinner === void 0 ? void 0 : spinner.message("Uploading update.json");
                const Key = "update.json";
                const Body = JSON.stringify(updateSources);
                const ContentType = (_a = mime.getType(Key)) !== null && _a !== void 0 ? _a : void 0;
                const upload = new Upload({
                    client,
                    params: {
                        ContentType,
                        Bucket: bucketName,
                        Key,
                        Body,
                    },
                });
                yield upload.done();
            });
        },
        updateUpdateJson(targetBundleVersion, newSource) {
            return __awaiter(this, void 0, void 0, function* () {
                updateSources = yield this.getUpdateJson();
                const targetIndex = updateSources.findIndex((u) => u.bundleVersion === targetBundleVersion);
                if (targetIndex === -1) {
                    throw new Error("target bundle version not found");
                }
                updateSources[targetIndex] = newSource;
            });
        },
        appendUpdateJson(source) {
            return __awaiter(this, void 0, void 0, function* () {
                updateSources = yield this.getUpdateJson();
                updateSources.unshift(source);
            });
        },
        setUpdateJson(sources) {
            return __awaiter(this, void 0, void 0, function* () {
                updateSources = sources;
            });
        },
        getUpdateJson() {
            return __awaiter(this, arguments, void 0, function* (refresh = false) {
                if (updateSources.length > 0 && !refresh) {
                    return updateSources;
                }
                spinner === null || spinner === void 0 ? void 0 : spinner.message("Getting update.json");
                try {
                    const command = new GetObjectCommand({
                        Bucket: bucketName,
                        Key: "update.json",
                    });
                    const { Body: UpdateJsonBody } = yield client.send(command);
                    const bodyContents = yield streamToString(UpdateJsonBody);
                    const updateJson = JSON.parse(bodyContents);
                    updateSources = updateJson;
                    return updateJson;
                }
                catch (e) {
                    if (e instanceof NoSuchKey) {
                        return [];
                    }
                    throw e;
                }
            });
        },
        deleteBundle(platform, bundleVersion) {
            return __awaiter(this, void 0, void 0, function* () {
                const Key = [bundleVersion, platform].join("/");
                const listCommand = new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: `${bundleVersion}/${platform}`,
                });
                const listResponse = yield client.send(listCommand);
                if (listResponse.Contents && listResponse.Contents.length > 0) {
                    const objectsToDelete = listResponse.Contents.map((obj) => ({
                        Key: obj.Key,
                    }));
                    const deleteParams = {
                        Bucket: bucketName,
                        Delete: {
                            Objects: objectsToDelete,
                            Quiet: true,
                        },
                    };
                    const deleteCommand = new DeleteObjectsCommand(deleteParams);
                    yield client.send(deleteCommand);
                    return Key;
                }
                spinner === null || spinner === void 0 ? void 0 : spinner.error("Bundle Not Found");
                throw new Error("Bundle Not Found");
            });
        },
        uploadBundle(platform, bundleVersion, bundlePath) {
            return __awaiter(this, void 0, void 0, function* () {
                var _a;
                spinner === null || spinner === void 0 ? void 0 : spinner.message("Uploading Bundle");
                const Body = yield fs.readFile(bundlePath);
                const ContentType = (_a = mime.getType(bundlePath)) !== null && _a !== void 0 ? _a : void 0;
                const filename = path.basename(bundlePath);
                const Key = [bundleVersion, platform, filename].join("/");
                const upload = new Upload({
                    client,
                    params: {
                        ContentType,
                        Bucket: bucketName,
                        Key,
                        Body,
                    },
                });
                const response = yield upload.done();
                if (!response.Location) {
                    spinner === null || spinner === void 0 ? void 0 : spinner.error("Upload Failed");
                    throw new Error("Upload Failed");
                }
                log === null || log === void 0 ? void 0 : log.info(`Uploaded: ${Key}`);
                return {
                    file: response.Location,
                };
            });
        },
    };
};
//# sourceMappingURL=aws.js.map