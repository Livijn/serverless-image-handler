// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import S3 from 'aws-sdk/clients/s3';
import { createHmac } from 'crypto';

import {
  DefaultImageRequest,
  Headers,
  ImageEdits,
  ImageFormatTypes,
  ImageHandlerError,
  ImageHandlerEvent,
  ImageRequestInfo,
  RequestTypes,
  StatusCodes
} from './lib';
import { SecretProvider } from './secret-provider';

type OriginalImageInfo = Partial<{
  contentType: string;
  expires: string;
  lastModified: string;
  cacheControl: string;
  originalImage: Buffer;
}>;

const BUCKET = 'getdogsapp';
const SIZES = {small: 64, medium: 400, large: 1000, placeholder: 300};
const QUALITIES = {small: 75, medium: 85, large: 100, placeholder: 40};

export class ImageRequest {
  private static readonly DEFAULT_REDUCTION_EFFORT = 4;

  constructor(private readonly s3Client: S3, private readonly secretProvider: SecretProvider) {}

  /**
   * Initializer function for creating a new image request, used by the image handler to perform image modifications.
   * @param event Lambda request body.
   * @returns Initialized image request information.
   */
  public async setup(event: ImageHandlerEvent): Promise<ImageRequestInfo> {
    try {
      await this.validateRequestSignature(event);

      let imageRequestInfo: ImageRequestInfo = <ImageRequestInfo>{};

      imageRequestInfo.requestType = this.parseRequestType(event);
      imageRequestInfo.bucket = this.parseImageBucket(event, imageRequestInfo.requestType);
      imageRequestInfo.key = this.parseImageKey(event, imageRequestInfo.requestType);
      imageRequestInfo.edits = this.parseImageEdits(event, imageRequestInfo.requestType);

      const originalImage = await this.getOriginalImage(imageRequestInfo.bucket, imageRequestInfo.key);
      imageRequestInfo = { ...imageRequestInfo, ...originalImage };

      imageRequestInfo.headers = this.parseImageHeaders(event, imageRequestInfo.requestType);

      // If the original image is SVG file and it has any edits but no output format, change the format to WebP.
      if (imageRequestInfo.contentType === 'image/svg+xml' && imageRequestInfo.edits && Object.keys(imageRequestInfo.edits).length > 0 && !imageRequestInfo.edits.toFormat) {
        imageRequestInfo.outputFormat = ImageFormatTypes.PNG;
      }

      /* Decide the output format of the image.
       * 1) If the format is provided, the output format is the provided format.
       * 2) If headers contain "Accept: image/webp", the output format is webp.
       * 3) Use the default image format for the rest of cases.
       */
      if (imageRequestInfo.contentType !== 'image/svg+xml' || imageRequestInfo.edits.toFormat || imageRequestInfo.outputFormat) {
        const outputFormat = this.getOutputFormat(event, imageRequestInfo.requestType);
        // if webp check reduction effort, if invalid value, use 4 (default in sharp)
        if (outputFormat === ImageFormatTypes.WEBP && imageRequestInfo.requestType === RequestTypes.DEFAULT) {
          const decoded = this.decodeRequest(event);
          if (typeof decoded.reductionEffort !== 'undefined') {
            const reductionEffort = Math.trunc(decoded.reductionEffort);
            const isValid = !isNaN(reductionEffort) && reductionEffort >= 0 && reductionEffort <= 6;
            imageRequestInfo.reductionEffort = isValid ? reductionEffort : ImageRequest.DEFAULT_REDUCTION_EFFORT;
          }
        }
        if (imageRequestInfo.edits && imageRequestInfo.edits.toFormat) {
          imageRequestInfo.outputFormat = imageRequestInfo.edits.toFormat;
        } else if (outputFormat) {
          imageRequestInfo.outputFormat = outputFormat;
        }
      }

      // Fix quality for Thumbor and Custom request type if outputFormat is different from quality type.
      if (imageRequestInfo.outputFormat) {
        const requestType = [RequestTypes.CUSTOM, RequestTypes.THUMBOR];
        const acceptedValues = [ImageFormatTypes.JPEG, ImageFormatTypes.PNG, ImageFormatTypes.WEBP, ImageFormatTypes.TIFF, ImageFormatTypes.HEIF];

        imageRequestInfo.contentType = `image/${imageRequestInfo.outputFormat}`;
        if (requestType.includes(imageRequestInfo.requestType) && acceptedValues.includes(imageRequestInfo.outputFormat)) {
          const qualityKey = Object.keys(imageRequestInfo.edits).filter(key => acceptedValues.includes(key as ImageFormatTypes))[0];

          if (qualityKey && qualityKey !== imageRequestInfo.outputFormat) {
            imageRequestInfo.edits[imageRequestInfo.outputFormat] = imageRequestInfo.edits[qualityKey];
            delete imageRequestInfo.edits[qualityKey];
          }
        }
      }

      return imageRequestInfo;
    } catch (error) {
      console.error(error);

      throw error;
    }
  }

  /**
   * Gets the original image from an Amazon S3 bucket.
   * @param bucket The name of the bucket containing the image.
   * @param key The key name corresponding to the image.
   * @returns The original image or an error.
   */
  public async getOriginalImage(bucket: string, key: string): Promise<OriginalImageInfo> {
    try {
      const result: OriginalImageInfo = {};

      const imageLocation = { Bucket: bucket, Key: key };
      const originalImage = await this.s3Client.getObject(imageLocation).promise();
      const imageBuffer = Buffer.from(originalImage.Body as Uint8Array);

      if (originalImage.ContentType) {
        // If using default S3 ContentType infer from hex headers
        if (['binary/octet-stream', 'application/octet-stream'].includes(originalImage.ContentType)) {
          result.contentType = this.inferImageType(imageBuffer);
        } else {
          result.contentType = originalImage.ContentType;
        }
      } else {
        result.contentType = 'image';
      }

      if (originalImage.Expires) {
        result.expires = new Date(originalImage.Expires).toUTCString();
      }

      if (originalImage.LastModified) {
        result.lastModified = new Date(originalImage.LastModified).toUTCString();
      }

      result.cacheControl = originalImage.CacheControl ?? 'max-age=31536000,public';
      result.originalImage = imageBuffer;

      return result;
    } catch (error) {
      let status = StatusCodes.INTERNAL_SERVER_ERROR;
      let message = error.message;
      if (error.code === 'NoSuchKey') {
        status = StatusCodes.NOT_FOUND;
        message = `The image ${key} does not exist or the request may not be base64 encoded properly.`;
      }
      throw new ImageHandlerError(status, error.code, message);
    }
  }

  /**
   * Parses the name of the appropriate Amazon S3 bucket to source the original image from.
   * @param event Lambda request body.
   * @param requestType Image handler request type.
   * @returns The name of the appropriate Amazon S3 bucket.
   */
  public parseImageBucket(event: ImageHandlerEvent, requestType: RequestTypes): string {
    const decoded = this.decodeRequest(event);
    return decoded.bucket;
  }

  /**
   * Parses the edits to be made to the original image.
   * @param event Lambda request body.
   * @param requestType Image handler request type.
   * @returns The edits to be made to the original image.
   */
  public parseImageEdits(event: ImageHandlerEvent, requestType: RequestTypes): ImageEdits {
    const decoded = this.decodeRequest(event);
    return decoded.edits;
  }

  /**
   * Parses the name of the appropriate Amazon S3 key corresponding to the original image.
   * @param event Lambda request body.
   * @param requestType Type of the request.
   * @returns The name of the appropriate Amazon S3 key.
   */
  public parseImageKey(event: ImageHandlerEvent, requestType: RequestTypes): string {
    const decoded = this.decodeRequest(event);
    return decoded.key;
  }

  /**
   * Determines how to handle the request being made based on the URL path prefix to the image request.
   * Categorizes a request as either "image" (uses the Sharp library), "thumbor" (uses Thumbor mapping), or "custom" (uses the rewrite function).
   * @param event Lambda request body.
   * @returns The request type.
   */
  public parseRequestType(event: ImageHandlerEvent): RequestTypes {
    return RequestTypes.DEFAULT;
  }

  /**
   * Parses the headers to be sent with the response.
   * @param event Lambda request body.
   * @param requestType Image handler request type.
   * @returns The headers to be sent with the response.
   */
  public parseImageHeaders(event: ImageHandlerEvent, requestType: RequestTypes): Headers {
    if (requestType === RequestTypes.DEFAULT) {
      const { headers } = this.decodeRequest(event);
      if (headers) {
        return headers;
      }
    }
  }

  /**
   * Decodes the base64-encoded image request path associated with default image requests.
   * Provides error handling for invalid or undefined path values.
   * @param event Lambda request body.
   * @returns The decoded from base-64 image request.
   */
  public decodeRequest(event: ImageHandlerEvent): DefaultImageRequest {
    const [, id, size] = event.path.split('/');

    let edits = {
      webp: {
        quality: QUALITIES[size],
      },
      jpeg: {
        quality: QUALITIES[size],
      },
      resize: {
        width: SIZES[size],
        height: SIZES[size],
        fit: "inside"
      },
    };

    if (size === 'placeholder') {
      edits['blur'] = 30;
    }

    return {
      bucket: BUCKET,
      key: `content/${id}`,
      edits,
    };
  }

  /**
   * Returns a formatted image source bucket allowed list as specified in the SOURCE_BUCKETS environment variable of the image handler Lambda function.
   * Provides error handling for missing/invalid values.
   * @returns A formatted image source bucket.
   */
  public getAllowedSourceBuckets(): string[] {
    const { SOURCE_BUCKETS } = process.env;

    if (SOURCE_BUCKETS === undefined) {
      throw new ImageHandlerError(
        StatusCodes.BAD_REQUEST,
        'GetAllowedSourceBuckets::NoSourceBuckets',
        'The SOURCE_BUCKETS variable could not be read. Please check that it is not empty and contains at least one source bucket, or multiple buckets separated by commas. Spaces can be provided between commas and bucket names, these will be automatically parsed out when decoding.'
      );
    } else {
      return SOURCE_BUCKETS.replace(/\s+/g, '').split(',');
    }
  }

  /**
   * Return the output format depending on the accepts headers and request type.
   * @param event Lambda request body.
   * @param requestType The request type.
   * @returns The output format.
   */
  public getOutputFormat(event: ImageHandlerEvent, requestType: RequestTypes = undefined): ImageFormatTypes {
    const { AUTO_WEBP } = process.env;

    if (AUTO_WEBP === 'Yes' && event.headers.Accept && event.headers.Accept.includes('image/webp')) {
      return ImageFormatTypes.WEBP;
    } else if (requestType === RequestTypes.DEFAULT) {
      const decoded = this.decodeRequest(event);
      return decoded.outputFormat;
    }

    return null;
  }

  /**
   * Return the output format depending on first four hex values of an image file.
   * @param imageBuffer Image buffer.
   * @returns The output format.
   */
  public inferImageType(imageBuffer: Buffer): string {
    const imageSignature = imageBuffer.slice(0, 4).toString('hex').toUpperCase();
    switch (imageSignature) {
      case '89504E47':
        return 'image/png';
      case 'FFD8FFDB':
      case 'FFD8FFE0':
      case 'FFD8FFEE':
      case 'FFD8FFE1':
        return 'image/jpeg';
      case '52494646':
        return 'image/webp';
      case '49492A00':
        return 'image/tiff';
      case '4D4D002A':
        return 'image/tiff';
      default:
        throw new ImageHandlerError(
          StatusCodes.INTERNAL_SERVER_ERROR,
          'RequestTypeError',
          'The file does not have an extension and the file type could not be inferred. Please ensure that your original image is of a supported file type (jpg, png, tiff, webp, svg). Refer to the documentation for additional guidance on forming image requests.'
        );
    }
  }

  /**
   * Validates the request's signature.
   * @param event Lambda request body.
   * @returns A promise.
   * @throws Throws the error if validation is enabled and the provided signature is invalid.
   */
  private async validateRequestSignature(event: ImageHandlerEvent): Promise<void> {
    const { ENABLE_SIGNATURE, SECRETS_MANAGER, SECRET_KEY } = process.env;

    // Checks signature enabled
    if (ENABLE_SIGNATURE === 'Yes') {
      const { path, queryStringParameters } = event;

      if (!queryStringParameters?.signature) {
        throw new ImageHandlerError(StatusCodes.BAD_REQUEST, 'AuthorizationQueryParametersError', 'Query-string requires the signature parameter.');
      }

      try {
        const { signature } = queryStringParameters;
        const secret = JSON.parse(await this.secretProvider.getSecret(SECRETS_MANAGER));
        const key = secret[SECRET_KEY];
        const hash = createHmac('sha256', key).update(path).digest('hex');

        // Signature should be made with the full path.
        if (signature !== hash) {
          throw new ImageHandlerError(StatusCodes.FORBIDDEN, 'SignatureDoesNotMatch', 'Signature does not match.');
        }
      } catch (error) {
        if (error.code === 'SignatureDoesNotMatch') {
          throw error;
        }

        console.error('Error occurred while checking signature.', error);
        throw new ImageHandlerError(StatusCodes.INTERNAL_SERVER_ERROR, 'SignatureValidationFailure', 'Signature validation failed.');
      }
    }
  }
}
