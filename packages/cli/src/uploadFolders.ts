// import { S3Client } from "@aws-sdk/client-s3";
// import { Upload } from "@aws-sdk/lib-storage";
// import fs from "fs";
// import path from "path";

// const uploadFileWithProgress = async (filePath, s3Key) => {
//   const fileStream = fs.createReadStream(filePath);
//   const params = {
//     Bucket: BUCKET_NAME,
//     Key: s3Key,
//     Body: fileStream,
//   };
//   const uploader = new Upload({
//     client: client,
//     params: params,
//   });

//   uploader.on("httpUploadProgress", (progress) => {
//     const { loaded = 0, total = 0 } = progress;

//     console.log(`Uploading ${s3Key}: ${((loaded / total) * 100).toFixed(2)}%`);
//   });

//   return uploader.done();
// };

// const uploadFolder = async (folderPath, prefix = "") => {
//   const files = fs.readdirSync(folderPath);
//   for (const file of files) {
//     const filePath = path.join(folderPath, file);
//     const s3Key = path.join(prefix, file);

//     if (fs.statSync(filePath).isDirectory()) {
//       await uploadFolder(filePath, s3Key);
//     } else {
//       await uploadFileWithProgress(filePath, s3Key);
//     }
//   }
// };
