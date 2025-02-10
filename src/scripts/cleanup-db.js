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
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
var client_1 = require("@prisma/client");
var client_s3_1 = require("@aws-sdk/client-s3");
var prisma = new client_1.PrismaClient();
var s3Client = new client_s3_1.S3Client({ region: process.env.AWS_REGION });
function cleanupS3Bucket(bucketName) {
    return __awaiter(this, void 0, void 0, function () {
        var listCommand, listedObjects, deleteCommand, error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("Cleaning up S3 bucket: ".concat(bucketName, "..."));
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    listCommand = new client_s3_1.ListObjectsV2Command({
                        Bucket: bucketName,
                    });
                    return [4 /*yield*/, s3Client.send(listCommand)];
                case 2:
                    listedObjects = _a.sent();
                    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
                        console.log("\u2713 Bucket ".concat(bucketName, " is already empty"));
                        return [2 /*return*/];
                    }
                    deleteCommand = new client_s3_1.DeleteObjectsCommand({
                        Bucket: bucketName,
                        Delete: {
                            Objects: listedObjects.Contents.map(function (_a) {
                                var Key = _a.Key;
                                return ({ Key: Key });
                            }),
                        },
                    });
                    return [4 /*yield*/, s3Client.send(deleteCommand)];
                case 3:
                    _a.sent();
                    console.log("\u2713 Deleted ".concat(listedObjects.Contents.length, " objects from ").concat(bucketName));
                    if (!listedObjects.IsTruncated) return [3 /*break*/, 5];
                    return [4 /*yield*/, cleanupS3Bucket(bucketName)];
                case 4:
                    _a.sent();
                    _a.label = 5;
                case 5: return [3 /*break*/, 7];
                case 6:
                    error_1 = _a.sent();
                    console.error("Error cleaning S3 bucket ".concat(bucketName, ":"), error_1);
                    throw error_1;
                case 7: return [2 /*return*/];
            }
        });
    });
}
function cleanup() {
    return __awaiter(this, void 0, void 0, function () {
        var buckets, _i, buckets_1, bucket, error_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("Starting cleanup...");
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 9, 10, 12]);
                    buckets = [
                        process.env.S3_BUCKET, // Main bucket
                        process.env.VIDEOS_BUCKET_NAME, // Videos bucket if different
                    ].filter(Boolean);
                    console.log("Cleaning up S3 buckets...");
                    _i = 0, buckets_1 = buckets;
                    _a.label = 2;
                case 2:
                    if (!(_i < buckets_1.length)) return [3 /*break*/, 5];
                    bucket = buckets_1[_i];
                    return [4 /*yield*/, cleanupS3Bucket(bucket)];
                case 3:
                    _a.sent();
                    _a.label = 4;
                case 4:
                    _i++;
                    return [3 /*break*/, 2];
                case 5:
                    console.log("✓ S3 cleanup completed");
                    // Delete all jobs first (due to foreign key constraints)
                    console.log("Deleting video jobs...");
                    return [4 /*yield*/, prisma.videoJob.deleteMany({})];
                case 6:
                    _a.sent();
                    console.log("✓ All video jobs deleted");
                    // Delete all photos
                    console.log("Deleting photos...");
                    return [4 /*yield*/, prisma.photo.deleteMany({})];
                case 7:
                    _a.sent();
                    console.log("✓ All photos deleted");
                    // Delete all listings
                    console.log("Deleting listings...");
                    return [4 /*yield*/, prisma.listing.deleteMany({})];
                case 8:
                    _a.sent();
                    console.log("✓ All listings deleted");
                    console.log("Cleanup completed successfully!");
                    return [3 /*break*/, 12];
                case 9:
                    error_2 = _a.sent();
                    console.error("Error during cleanup:", error_2);
                    return [3 /*break*/, 12];
                case 10: return [4 /*yield*/, prisma.$disconnect()];
                case 11:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 12: return [2 /*return*/];
            }
        });
    });
}
cleanup();
