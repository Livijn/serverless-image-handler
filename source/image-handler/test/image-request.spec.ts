// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { mockAwsS3, mockAwsSecretManager } from './mock';

import SecretsManager from 'aws-sdk/clients/secretsmanager';
import S3 from 'aws-sdk/clients/s3';

import { ImageRequest } from '../image-request';
import { ImageHandlerError, RequestTypes, StatusCodes } from '../lib';
import { SecretProvider } from '../secret-provider';

describe('setup()', () => {
  const s3Client = new S3();
  const secretsManager = new SecretsManager();
  let secretProvider = new SecretProvider(secretsManager);

  beforeEach(() => {
    jest.resetAllMocks();
  });

  afterEach(() => {
    jest.clearAllMocks();
    secretProvider = new SecretProvider(secretsManager); // need to re-create the provider to make sure the secret is not cached
  });

  describe('001/defaultImageRequest', () => {
    const OLD_ENV = process.env;

    beforeEach(() => {
      jest.resetAllMocks();
      process.env = { ...OLD_ENV };
    });

    afterEach(() => {
      jest.clearAllMocks();
    });

    afterAll(() => {
      process.env = OLD_ENV;
    });

    it('Should pass when a default image request is provided and populate the ImageRequest object with the proper values', async () => {
      // Arrange
      const event = {
        path: '/image/large'
      };
      process.env.SOURCE_BUCKETS = 'validBucket, validBucket2';

      // Mock
      mockAwsS3.getObject.mockImplementationOnce(() => ({
        promise() {
          return Promise.resolve({ Body: Buffer.from('SampleImageContent\n') });
        }
      }));

      // Act
      const imageRequest = new ImageRequest(s3Client, secretProvider);
      const imageRequestInfo = await imageRequest.setup(event);
      const expectedResult = {
        requestType: 'Default',
        bucket: 'getdogsapp',
        key: 'content/image',
        edits: {
          webp: {
            quality: 95,
          },
          jpeg: {
            quality: 95,
          },
          resize: {
            width: 1000,
            height: 1000,
            fit: "inside"
          },
          contentModeration: {
            minConfidence: 95,
            blur: 100,
            moderationLabels: [
              "Explicit Nudity",
              "Violence",
              "Visually Disturbing",
              "Hate Symbols"
            ]
          }
        },
        originalImage: Buffer.from('SampleImageContent\n'),
        cacheControl: 'max-age=31536000,public',
        contentType: 'image',
        headers: undefined,
      };

      // Assert
      expect(mockAwsS3.getObject).toHaveBeenCalledWith({ Bucket: 'getdogsapp', Key: 'content/image' });
      expect(imageRequestInfo).toEqual(expectedResult);
    });
  });

  describe('002/shouldNotInferImageType', () => {
    it('Should pass throw an exception', () => {
      // Arrange
      const imageBuffer = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);

      try {
        // Act
        const imageRequest = new ImageRequest(s3Client, secretProvider);
        imageRequest.inferImageType(imageBuffer);
      } catch (error) {
        // Assert
        expect(error.status).toEqual(500);
        expect(error.code).toEqual('RequestTypeError');
        expect(error.message).toEqual(
          'The file does not have an extension and the file type could not be inferred. Please ensure that your original image is of a supported file type (jpg, png, tiff, webp, svg). Refer to the documentation for additional guidance on forming image requests.'
        );
      }
    });
  });
});
