"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.saveCache = exports.reserveCache = exports.downloadCache = exports.getCacheEntry = exports.getCacheVersion = void 0;
const core = __importStar(require("@actions/core"));
const http_client_1 = require("@actions/http-client");
const auth_1 = require("@actions/http-client/lib/auth");
const client_s3_1 = require("@aws-sdk/client-s3");
const lib_storage_1 = require("@aws-sdk/lib-storage");
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs"));
const url_1 = require("url");
const utils = __importStar(require("./cacheUtils"));
const downloadUtils_1 = require("./downloadUtils");
const options_1 = require("../options");
const requestUtils_1 = require("./requestUtils");
const versionSalt = '1.0';
function getCacheApiUrl(resource) {
    const baseUrl = process.env['ACTIONS_CACHE_URL'] || '';
    if (!baseUrl) {
        throw new Error('Cache Service Url not found, unable to restore cache.');
    }
    const url = `${baseUrl}_apis/artifactcache/${resource}`;
    core.debug(`Resource Url: ${url}`);
    return url;
}
function createAcceptHeader(type, apiVersion) {
    return `${type};api-version=${apiVersion}`;
}
function getRequestOptions() {
    const requestOptions = {
        headers: {
            Accept: createAcceptHeader('application/json', '6.0-preview.1')
        }
    };
    return requestOptions;
}
function createHttpClient() {
    const token = process.env['ACTIONS_RUNTIME_TOKEN'] || '';
    const bearerCredentialHandler = new auth_1.BearerCredentialHandler(token);
    return new http_client_1.HttpClient('actions/cache', [bearerCredentialHandler], getRequestOptions());
}
function getCacheVersion(paths, compressionMethod, enableCrossOsArchive = false) {
    const components = paths;
    // Add compression method to cache version to restore
    // compressed cache as per compression method
    if (compressionMethod) {
        components.push(compressionMethod);
    }
    // Only check for windows platforms if enableCrossOsArchive is false
    if (process.platform === 'win32' && !enableCrossOsArchive) {
        components.push('windows-only');
    }
    // Add salt to cache version to support breaking changes in cache entry
    components.push(versionSalt);
    return crypto.createHash('sha256').update(components.join('|')).digest('hex');
}
exports.getCacheVersion = getCacheVersion;
function getCacheEntryS3(s3Options, s3BucketName, keys, paths) {
    return __awaiter(this, void 0, void 0, function* () {
        const primaryKey = keys[0];
        const s3client = new client_s3_1.S3Client(s3Options);
        let contents = new Array();
        let s3ContinuationToken = undefined;
        let count = 0;
        const param = {
            Bucket: s3BucketName
        };
        for (;;) {
            core.debug(`ListObjects Count: ${count}`);
            if (s3ContinuationToken != undefined) {
                param.ContinuationToken = s3ContinuationToken;
            }
            let response;
            try {
                response = yield s3client.send(new client_s3_1.ListObjectsV2Command(param));
            }
            catch (e) {
                throw new Error(`Error from S3: ${e}`);
            }
            if (!response.Contents) {
                if (contents.length != 0) {
                    break;
                }
                throw new Error(`Cannot found object in bucket ${s3BucketName}`);
            }
            core.debug(`Found objects ${response.Contents.length}`);
            const found = response.Contents.find((content) => content.Key === primaryKey);
            if (found && found.LastModified) {
                return {
                    cacheKey: primaryKey,
                    creationTime: found.LastModified.toString()
                };
            }
            response.Contents.map((obj) => contents.push({
                Key: obj.Key,
                LastModified: obj.LastModified
            }));
            core.debug(`Total objects ${contents.length}`);
            if (response.IsTruncated) {
                s3ContinuationToken = response.NextContinuationToken;
            }
            else {
                break;
            }
            count++;
        }
        core.debug('Not found in primary key, will fallback to restore keys');
        const notPrimaryKey = keys.slice(1);
        const found = searchRestoreKeyEntry(notPrimaryKey, contents);
        if (found != null && found.LastModified) {
            return {
                cacheKey: found.Key,
                creationTime: found.LastModified.toString()
            };
        }
        return null;
    });
}
function searchRestoreKeyEntry(notPrimaryKey, entries) {
    for (const k of notPrimaryKey) {
        const found = _searchRestoreKeyEntry(k, entries);
        if (found != null) {
            return found;
        }
    }
    return null;
}
function _searchRestoreKeyEntry(notPrimaryKey, entries) {
    var _a;
    let matchPrefix = new Array();
    for (const entry of entries) {
        if (entry.Key === notPrimaryKey) {
            // extractly match, Use this entry
            return entry;
        }
        if ((_a = entry.Key) === null || _a === void 0 ? void 0 : _a.startsWith(notPrimaryKey)) {
            matchPrefix.push(entry);
        }
    }
    if (matchPrefix.length === 0) {
        // not found, go to next key
        return null;
    }
    matchPrefix.sort(function (i, j) {
        var _a, _b, _c, _d, _e, _f;
        if (i.LastModified == undefined || j.LastModified == undefined) {
            return 0;
        }
        if (((_a = i.LastModified) === null || _a === void 0 ? void 0 : _a.getTime()) === ((_b = j.LastModified) === null || _b === void 0 ? void 0 : _b.getTime())) {
            return 0;
        }
        if (((_c = i.LastModified) === null || _c === void 0 ? void 0 : _c.getTime()) > ((_d = j.LastModified) === null || _d === void 0 ? void 0 : _d.getTime())) {
            return -1;
        }
        if (((_e = i.LastModified) === null || _e === void 0 ? void 0 : _e.getTime()) < ((_f = j.LastModified) === null || _f === void 0 ? void 0 : _f.getTime())) {
            return 1;
        }
        return 0;
    });
    // return newest entry
    return matchPrefix[0];
}
function getCacheEntry(keys, paths, options, s3Options, s3BucketName) {
    return __awaiter(this, void 0, void 0, function* () {
        if (s3Options && s3BucketName) {
            return yield getCacheEntryS3(s3Options, s3BucketName, keys, paths);
        }
        const httpClient = createHttpClient();
        const version = getCacheVersion(paths, options === null || options === void 0 ? void 0 : options.compressionMethod, options === null || options === void 0 ? void 0 : options.enableCrossOsArchive);
        const resource = `cache?keys=${encodeURIComponent(keys.join(','))}&version=${version}`;
        const response = yield (0, requestUtils_1.retryTypedResponse)('getCacheEntry', () => __awaiter(this, void 0, void 0, function* () { return httpClient.getJson(getCacheApiUrl(resource)); }));
        // Cache not found
        if (response.statusCode === 204) {
            // List cache for primary key only if cache miss occurs
            if (core.isDebug()) {
                yield printCachesListForDiagnostics(keys[0], httpClient, version);
            }
            return null;
        }
        if (!(0, requestUtils_1.isSuccessStatusCode)(response.statusCode)) {
            throw new Error(`Cache service responded with ${response.statusCode}`);
        }
        const cacheResult = response.result;
        const cacheDownloadUrl = cacheResult === null || cacheResult === void 0 ? void 0 : cacheResult.archiveLocation;
        if (!cacheDownloadUrl) {
            // Cache achiveLocation not found. This should never happen, and hence bail out.
            throw new Error('Cache not found.');
        }
        core.setSecret(cacheDownloadUrl);
        core.debug(`Cache Result:`);
        core.debug(JSON.stringify(cacheResult));
        return cacheResult;
    });
}
exports.getCacheEntry = getCacheEntry;
function printCachesListForDiagnostics(key, httpClient, version) {
    return __awaiter(this, void 0, void 0, function* () {
        const resource = `caches?key=${encodeURIComponent(key)}`;
        const response = yield (0, requestUtils_1.retryTypedResponse)('listCache', () => __awaiter(this, void 0, void 0, function* () { return httpClient.getJson(getCacheApiUrl(resource)); }));
        if (response.statusCode === 200) {
            const cacheListResult = response.result;
            const totalCount = cacheListResult === null || cacheListResult === void 0 ? void 0 : cacheListResult.totalCount;
            if (totalCount && totalCount > 0) {
                core.debug(`No matching cache found for cache key '${key}', version '${version} and scope ${process.env['GITHUB_REF']}. There exist one or more cache(s) with similar key but they have different version or scope. See more info on cache matching here: https://docs.github.com/en/actions/using-workflows/caching-dependencies-to-speed-up-workflows#matching-a-cache-key \nOther caches with similar key:`);
                for (const cacheEntry of (cacheListResult === null || cacheListResult === void 0 ? void 0 : cacheListResult.artifactCaches) || []) {
                    core.debug(`Cache Key: ${cacheEntry === null || cacheEntry === void 0 ? void 0 : cacheEntry.cacheKey}, Cache Version: ${cacheEntry === null || cacheEntry === void 0 ? void 0 : cacheEntry.cacheVersion}, Cache Scope: ${cacheEntry === null || cacheEntry === void 0 ? void 0 : cacheEntry.scope}, Cache Created: ${cacheEntry === null || cacheEntry === void 0 ? void 0 : cacheEntry.creationTime}`);
                }
            }
        }
    });
}
function downloadCache(cacheEntry, archivePath, options, s3Options, s3BucketName) {
    var _a;
    return __awaiter(this, void 0, void 0, function* () {
        const archiveLocation = (_a = cacheEntry.archiveLocation) !== null && _a !== void 0 ? _a : 'https://example.com'; // for dummy
        const archiveUrl = new url_1.URL(archiveLocation);
        const downloadOptions = (0, options_1.getDownloadOptions)(options);
        if (archiveUrl.hostname.endsWith('.blob.core.windows.net')) {
            if (downloadOptions.useAzureSdk) {
                // Use Azure storage SDK to download caches hosted on Azure to improve speed and reliability.
                yield (0, downloadUtils_1.downloadCacheStorageSDK)(archiveLocation, archivePath, downloadOptions);
            }
            else if (downloadOptions.concurrentBlobDownloads) {
                // Use concurrent implementation with HttpClient to work around blob SDK issue
                yield (0, downloadUtils_1.downloadCacheHttpClientConcurrent)(archiveLocation, archivePath, downloadOptions);
            }
            else {
                // Otherwise, download using the Actions http-client.
                yield (0, downloadUtils_1.downloadCacheHttpClient)(archiveLocation, archivePath);
            }
        }
        else if (s3Options && s3BucketName && cacheEntry.cacheKey) {
            yield (0, downloadUtils_1.downloadCacheStorageS3)(cacheEntry.cacheKey, archivePath, s3Options, s3BucketName);
        }
        else {
            yield (0, downloadUtils_1.downloadCacheHttpClient)(archiveLocation, archivePath);
        }
    });
}
exports.downloadCache = downloadCache;
// Reserve Cache
function reserveCache(key, paths, options, s3Options, s3BucketName) {
    return __awaiter(this, void 0, void 0, function* () {
        if (s3Options && s3BucketName) {
            return {
                statusCode: 200,
                result: null,
                headers: {}
            };
        }
        const httpClient = createHttpClient();
        const version = getCacheVersion(paths, options === null || options === void 0 ? void 0 : options.compressionMethod, options === null || options === void 0 ? void 0 : options.enableCrossOsArchive);
        const reserveCacheRequest = {
            key,
            version,
            cacheSize: options === null || options === void 0 ? void 0 : options.cacheSize
        };
        const response = yield (0, requestUtils_1.retryTypedResponse)('reserveCache', () => __awaiter(this, void 0, void 0, function* () {
            return httpClient.postJson(getCacheApiUrl('caches'), reserveCacheRequest);
        }));
        return response;
    });
}
exports.reserveCache = reserveCache;
function getContentRange(start, end) {
    // Format: `bytes start-end/filesize
    // start and end are inclusive
    // filesize can be *
    // For a 200 byte chunk starting at byte 0:
    // Content-Range: bytes 0-199/*
    return `bytes ${start}-${end}/*`;
}
function uploadChunk(httpClient, resourceUrl, openStream, start, end) {
    return __awaiter(this, void 0, void 0, function* () {
        core.debug(`Uploading chunk of size ${end - start + 1} bytes at offset ${start} with content range: ${getContentRange(start, end)}`);
        const additionalHeaders = {
            'Content-Type': 'application/octet-stream',
            'Content-Range': getContentRange(start, end)
        };
        const uploadChunkResponse = yield (0, requestUtils_1.retryHttpClientResponse)(`uploadChunk (start: ${start}, end: ${end})`, () => __awaiter(this, void 0, void 0, function* () {
            return httpClient.sendStream('PATCH', resourceUrl, openStream(), additionalHeaders);
        }));
        if (!(0, requestUtils_1.isSuccessStatusCode)(uploadChunkResponse.message.statusCode)) {
            throw new Error(`Cache service responded with ${uploadChunkResponse.message.statusCode} during upload chunk.`);
        }
    });
}
function uploadFileS3(s3options, s3BucketName, archivePath, key, concurrency, maxChunkSize) {
    return __awaiter(this, void 0, void 0, function* () {
        core.debug(`Start upload to S3 (bucket: ${s3BucketName})`);
        const fileStream = fs.createReadStream(archivePath);
        try {
            const parallelUpload = new lib_storage_1.Upload({
                client: new client_s3_1.S3Client(s3options),
                queueSize: concurrency,
                partSize: maxChunkSize,
                params: {
                    Bucket: s3BucketName,
                    Key: key,
                    Body: fileStream
                }
            });
            parallelUpload.on('httpUploadProgress', (progress) => {
                core.debug(`Uploading chunk progress: ${JSON.stringify(progress)}`);
            });
            yield parallelUpload.done();
        }
        catch (error) {
            throw new Error(`Cache upload failed because ${error}`);
        }
        return;
    });
}
function uploadFile(httpClient, cacheId, archivePath, key, options, s3options, s3BucketName) {
    return __awaiter(this, void 0, void 0, function* () {
        // Upload Chunks
        const uploadOptions = (0, options_1.getUploadOptions)(options);
        const concurrency = utils.assertDefined('uploadConcurrency', uploadOptions.uploadConcurrency);
        const maxChunkSize = utils.assertDefined('uploadChunkSize', uploadOptions.uploadChunkSize);
        const parallelUploads = [...new Array(concurrency).keys()];
        core.debug('Awaiting all uploads');
        let offset = 0;
        if (s3options && s3BucketName) {
            yield uploadFileS3(s3options, s3BucketName, archivePath, key, concurrency, maxChunkSize);
            return;
        }
        const fileSize = utils.getArchiveFileSizeInBytes(archivePath);
        const resourceUrl = getCacheApiUrl(`caches/${cacheId.toString()}`);
        const fd = fs.openSync(archivePath, 'r');
        try {
            yield Promise.all(parallelUploads.map(() => __awaiter(this, void 0, void 0, function* () {
                while (offset < fileSize) {
                    const chunkSize = Math.min(fileSize - offset, maxChunkSize);
                    const start = offset;
                    const end = offset + chunkSize - 1;
                    offset += maxChunkSize;
                    yield uploadChunk(httpClient, resourceUrl, () => fs
                        .createReadStream(archivePath, {
                        fd,
                        start,
                        end,
                        autoClose: false
                    })
                        .on('error', error => {
                        throw new Error(`Cache upload failed because file read failed with ${error.message}`);
                    }), start, end);
                }
            })));
        }
        finally {
            fs.closeSync(fd);
        }
        return;
    });
}
function commitCache(httpClient, cacheId, filesize) {
    return __awaiter(this, void 0, void 0, function* () {
        const commitCacheRequest = { size: filesize };
        return yield (0, requestUtils_1.retryTypedResponse)('commitCache', () => __awaiter(this, void 0, void 0, function* () {
            return httpClient.postJson(getCacheApiUrl(`caches/${cacheId.toString()}`), commitCacheRequest);
        }));
    });
}
function saveCache(cacheId, archivePath, key, options, s3Options, s3BucketName) {
    return __awaiter(this, void 0, void 0, function* () {
        const httpClient = createHttpClient();
        core.debug('Upload cache');
        yield uploadFile(httpClient, cacheId, archivePath, key, options, s3Options, s3BucketName);
        // Commit Cache
        core.debug('Commiting cache');
        const cacheSize = utils.getArchiveFileSizeInBytes(archivePath);
        core.info(`Cache Size: ~${Math.round(cacheSize / (1024 * 1024))} MB (${cacheSize} B)`);
        if (!s3Options) {
            // already commit on S3
            const commitCacheResponse = yield commitCache(httpClient, cacheId, cacheSize);
            if (!(0, requestUtils_1.isSuccessStatusCode)(commitCacheResponse.statusCode)) {
                throw new Error(`Cache service responded with ${commitCacheResponse.statusCode} during commit cache.`);
            }
        }
        core.info('Cache saved successfully');
    });
}
exports.saveCache = saveCache;
//# sourceMappingURL=cacheHttpClient.js.map