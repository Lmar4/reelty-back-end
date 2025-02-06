import { z } from "zod";
import { router, protectedProcedure } from "../types";
import { StorageService } from "../../services/storage";
import { AssetType } from "../../constants/storage";

const storageService = StorageService.getInstance();

export const storageRouter = router({
  getPresignedUrl: protectedProcedure
    .input(
      z.object({
        fileName: z.string(),
        contentType: z.string(),
        type: z.enum(["MUSIC", "WATERMARK", "LOTTIE"]).optional(),
      })
    )
    .mutation(async ({ input }) => {
      if (input.type) {
        // Handle asset uploads
        const result = await storageService.uploadAsset({
          name: input.fileName,
          type: input.type as AssetType,
          contentType: input.contentType as any,
        });
        return result;
      }

      // Handle general file uploads
      const result = await storageService.uploadPropertyMedia(
        "temp", // We'll move it to the proper location after asset creation
        {
          name: input.fileName,
          type: "image",
          contentType: input.contentType as any,
        }
      );
      return result;
    }),
});
