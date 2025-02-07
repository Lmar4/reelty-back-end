import {
  StoragePathSchema,
  StoragePathParams,
  FileType,
  AllowedMimeTypes,
  AllowedMimeType,
  MaxFileSizes,
  STORAGE_BUCKET_NAME,
  AssetType,
} from "../../config/storage";
import {
  generateStoragePath,
  generatePresignedUploadUrl,
  generatePresignedDownloadUrl,
  deleteFile,
  sanitizeFilename,
  generateUniqueFilename,
} from "../../utils/storage";

export class StorageService {
  private static instance: StorageService;

  private constructor() {}

  public static getInstance(): StorageService {
    if (!StorageService.instance) {
      StorageService.instance = new StorageService();
    }
    return StorageService.instance;
  }

  async uploadPropertyMedia(
    propertyId: string,
    file: {
      name: string;
      type: FileType;
      contentType: AllowedMimeType;
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    // Validate mime type matches the file type
    const validMimeTypes = AllowedMimeTypes[file.type];
    const isValidMimeType = (validMimeTypes as readonly string[]).includes(
      file.contentType
    );
    if (!isValidMimeType) {
      throw new Error(`Unsupported file type: ${file.contentType}`);
    }

    // Generate unique filename and path
    const filename = generateUniqueFilename(file.name);
    let pathTemplate: string;

    switch (file.type) {
      case "image":
        pathTemplate = StoragePathSchema.PROPERTY.PHOTOS;
        break;
      case "video":
        pathTemplate = StoragePathSchema.PROPERTY.VIDEOS;
        break;
      case "document":
        pathTemplate = StoragePathSchema.PROPERTY.DOCUMENTS;
        break;
      default:
        throw new Error(`Unsupported file type: ${file.type}`);
    }

    const fileKey = `${generateStoragePath(pathTemplate, {
      propertyId,
    })}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async uploadUserDocument(
    userId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.document)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name);
    const fileKey = `${generateStoragePath(StoragePathSchema.USER.DOCUMENTS, {
      userId,
    })}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async uploadUserProfile(
    userId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name, "profile-");
    const fileKey = `${generateStoragePath(StoragePathSchema.USER.PROFILE, {
      userId,
    })}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async uploadOrganizationLogo(
    orgId: string,
    file: {
      name: string;
      contentType: (typeof AllowedMimeTypes.image)[number];
    }
  ): Promise<{ uploadUrl: string; fileKey: string }> {
    const filename = generateUniqueFilename(file.name, "logo-");
    const fileKey = `${generateStoragePath(
      StoragePathSchema.ORGANIZATION.LOGO,
      { orgId }
    )}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }

  async getDownloadUrl(fileKey: string): Promise<string> {
    return generatePresignedDownloadUrl(fileKey);
  }

  async deleteFile(fileKey: string): Promise<void> {
    return deleteFile(fileKey);
  }

  async uploadAsset(file: {
    name: string;
    type: AssetType;
    contentType: AllowedMimeType;
  }): Promise<{ uploadUrl: string; fileKey: string }> {
    // Validate mime type matches the file type
    const validMimeTypes = AllowedMimeTypes[file.type];
    const isValidMimeType = (validMimeTypes as readonly string[]).includes(
      file.contentType
    );
    if (!isValidMimeType) {
      throw new Error(`Unsupported file type: ${file.contentType}`);
    }

    // Generate unique filename and path
    const filename = generateUniqueFilename(file.name);
    let pathTemplate: string;

    switch (file.type) {
      case "MUSIC":
        pathTemplate = StoragePathSchema.ASSETS.MUSIC;
        break;
      case "WATERMARK":
        pathTemplate = StoragePathSchema.ASSETS.WATERMARK;
        break;
      case "LOTTIE":
        pathTemplate = StoragePathSchema.ASSETS.LOTTIE;
        break;
      default:
        throw new Error(`Unsupported asset type: ${file.type}`);
    }

    const fileKey = `${pathTemplate}/${filename}`;
    const uploadUrl = await generatePresignedUploadUrl(
      fileKey,
      file.contentType
    );

    return { uploadUrl, fileKey };
  }
}
