var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
import fs from "node:fs/promises";
import path from "node:path";
import Metro from "metro";
import Server from "metro/src/Server";
export const metro = (overrideConfig) => (_a) => __awaiter(void 0, [_a], void 0, function* ({ cwd, platform }) {
    const config = yield Metro.loadConfig({}, overrideConfig);
    const buildPath = path.join(cwd, "build");
    yield fs.rm(buildPath, { recursive: true, force: true });
    yield fs.mkdir(buildPath);
    const bundleOutput = path.join(cwd, "build", `index.${platform}.bundle`);
    const outputs = [];
    yield Metro.runBuild(config, {
        entry: "index.js",
        output: {
            build: (server, options) => __awaiter(void 0, void 0, void 0, function* () {
                const bundleOptions = Object.assign(Object.assign({}, Server.DEFAULT_BUNDLE_OPTIONS), options);
                // copy assets
                const assets = yield server.getAssets(Object.assign(Object.assign({}, bundleOptions), { bundleType: "bundle" }));
                let copyTargetFiles = [];
                switch (platform) {
                    case "ios": {
                        copyTargetFiles = assets
                            .flatMap((asset) => asset.files)
                            .map((file) => {
                            const resolvedPath = file.replace(cwd, "");
                            return {
                                from: file,
                                to: path.join(buildPath, "assets", resolvedPath),
                            };
                        });
                        break;
                    }
                    case "android": {
                        copyTargetFiles = assets
                            .flatMap((asset) => asset.files)
                            .map((file) => {
                            const resolvedPath = file
                                .replace(cwd, "")
                                .replace(/\/|\\/g, "_");
                            // file이 cwd + /src/image.png라면
                            // drawable-mdpi/src_image.png로 변경
                            console.log("AA", resolvedPath);
                            return {
                                from: file,
                                to: path.join(buildPath, "drawable-mdpi", resolvedPath),
                            };
                        });
                        break;
                    }
                }
                yield Promise.all(copyTargetFiles.map((_b) => __awaiter(void 0, [_b], void 0, function* ({ from, to }) {
                    yield fs.mkdir(path.dirname(to), { recursive: true });
                    yield fs.copyFile(from, to);
                    outputs.push(to);
                })));
                return server.build(bundleOptions);
            }),
            save: (_c, options_1) => __awaiter(void 0, [_c, options_1], void 0, function* ({ code, map }, options) {
                outputs.push(options.bundleOutput);
                yield fs.writeFile(options.bundleOutput, code);
                if (options.sourcemapOutput) {
                    outputs.push(options.sourcemapOutput);
                    yield fs.writeFile(options.sourcemapOutput, map);
                }
            }),
        },
        out: bundleOutput,
        platform,
        minify: true,
        sourceMap: true,
    });
    return {
        buildPath,
        outputs,
    };
});
//# sourceMappingURL=index.js.map