var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
export const aws = ({ baseUrl, bucketName, s3Client, }) => {
    return {
        getListObjects(prefix) {
            return __awaiter(this, void 0, void 0, function* () {
                var _a;
                /**
                 * Uses ListObjectsV2Command to fetch a list of objects from an S3 bucket.
                 * Note: A single invocation of ListObjectsV2Command can retrieve a maximum of 1,000 objects.
                 */
                const command = new ListObjectsV2Command({
                    Bucket: bucketName,
                    Prefix: prefix,
                });
                const data = yield s3Client.send(command);
                const files = (_a = data.Contents) === null || _a === void 0 ? void 0 : _a.filter(({ Key }) => Key !== prefix).map((content) => [baseUrl, content.Key].join("/"));
                return files !== null && files !== void 0 ? files : [];
            });
        },
    };
};
export { S3Client };
//# sourceMappingURL=read.js.map