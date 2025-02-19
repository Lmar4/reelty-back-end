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
var prisma = new client_1.PrismaClient();
function cleanDatabase() {
    return __awaiter(this, void 0, void 0, function () {
        var error_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 21, 22, 24]);
                    console.log("Starting database cleanup...");
                    // Delete independent tables first (no foreign key dependencies)
                    console.log("Deleting CacheLock records...");
                    return [4 /*yield*/, prisma.cacheLock.deleteMany()];
                case 1:
                    _a.sent();
                    console.log("Deleting ListingLock records...");
                    return [4 /*yield*/, prisma.listingLock.deleteMany()];
                case 2:
                    _a.sent();
                    console.log("Deleting CachedAsset records...");
                    return [4 /*yield*/, prisma.cachedAsset.deleteMany()];
                case 3:
                    _a.sent();
                    console.log("Deleting ProcessedAsset records...");
                    return [4 /*yield*/, prisma.processedAsset.deleteMany()];
                case 4:
                    _a.sent();
                    // Delete tables with user dependencies in correct order
                    console.log("Deleting SearchHistory records...");
                    return [4 /*yield*/, prisma.searchHistory.deleteMany()];
                case 5:
                    _a.sent();
                    console.log("Deleting ErrorLog records...");
                    return [4 /*yield*/, prisma.errorLog.deleteMany()];
                case 6:
                    _a.sent();
                    console.log("Deleting TempUpload records...");
                    return [4 /*yield*/, prisma.tempUpload.deleteMany()];
                case 7:
                    _a.sent();
                    // Delete video related records
                    console.log("Deleting VideoGenerationJob records...");
                    return [4 /*yield*/, prisma.videoGenerationJob.deleteMany()];
                case 8:
                    _a.sent();
                    console.log("Deleting VideoJob records...");
                    return [4 /*yield*/, prisma.videoJob.deleteMany()];
                case 9:
                    _a.sent();
                    // Delete listing related records
                    console.log("Deleting Photo records...");
                    return [4 /*yield*/, prisma.photo.deleteMany()];
                case 10:
                    _a.sent();
                    console.log("Deleting Listing records...");
                    return [4 /*yield*/, prisma.listing.deleteMany()];
                case 11:
                    _a.sent();
                    console.log("Deleting ListingCredit records...");
                    return [4 /*yield*/, prisma.listingCredit.deleteMany()];
                case 12:
                    _a.sent();
                    // Delete subscription related records
                    console.log("Deleting SubscriptionHistory records...");
                    return [4 /*yield*/, prisma.subscriptionHistory.deleteMany()];
                case 13:
                    _a.sent();
                    console.log("Deleting SubscriptionLog records...");
                    return [4 /*yield*/, prisma.subscriptionLog.deleteMany()];
                case 14:
                    _a.sent();
                    // Delete credit and tier related records
                    console.log("Deleting CreditLog records...");
                    return [4 /*yield*/, prisma.creditLog.deleteMany()];
                case 15:
                    _a.sent();
                    console.log("Deleting TierChange records...");
                    return [4 /*yield*/, prisma.tierChange.deleteMany()];
                case 16:
                    _a.sent();
                    // Delete asset related records
                    console.log("Deleting Asset records...");
                    return [4 /*yield*/, prisma.asset.deleteMany()];
                case 17:
                    _a.sent();
                    // Delete template related records
                    console.log("Deleting Template records...");
                    return [4 /*yield*/, prisma.template.deleteMany()];
                case 18:
                    _a.sent();
                    // Delete subscription tier related records
                    console.log("Deleting SubscriptionTier records...");
                    return [4 /*yield*/, prisma.subscriptionTier.deleteMany()];
                case 19:
                    _a.sent();
                    // Delete bulk discount records
                    console.log("Deleting BulkDiscount records...");
                    return [4 /*yield*/, prisma.bulkDiscount.deleteMany()];
                case 20:
                    _a.sent();
                    console.log("Database cleanup completed successfully!");
                    return [3 /*break*/, 24];
                case 21:
                    error_1 = _a.sent();
                    console.error("Error during database cleanup:", error_1);
                    throw error_1;
                case 22: return [4 /*yield*/, prisma.$disconnect()];
                case 23:
                    _a.sent();
                    return [7 /*endfinally*/];
                case 24: return [2 /*return*/];
            }
        });
    });
}
// Execute the cleanup
cleanDatabase().catch(function (error) {
    console.error("Failed to clean database:", error);
    process.exit(1);
});
