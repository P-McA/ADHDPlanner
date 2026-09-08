import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';

const DEFAULT_ENDPOINT = 'http://127.0.0.1:9000';
const DEFAULT_REGION = 'us-east-1';

/**
 * Object storage for uploaded media.
 *
 * Spoken to over the S3 API rather than a MinIO-specific one, so the only
 * difference between local development and a deployment is the endpoint and
 * the credentials. `forcePathStyle` is what makes that true: MinIO serves
 * `endpoint/bucket/key`, while the SDK defaults to virtual-host style
 * (`bucket.endpoint/key`), which does not resolve against a bare host.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageService.name);
  private readonly client: S3Client;

  constructor() {
    this.client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT ?? DEFAULT_ENDPOINT,
      region: process.env.MINIO_REGION ?? DEFAULT_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'adhd',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'adhd_local_dev',
      },
      // One attempt beyond the first, so an unreachable endpoint surfaces on
      // /health in about a second rather than after the SDK's default backoff.
      maxAttempts: 2,
    });
  }

  /**
   * Creates the bucket if it is missing, at boot.
   *
   * Chosen over an `mc` init container in docker-compose because compose only
   * exists locally: a container that creates the bucket would leave every
   * deployed environment with no equivalent step, so the bucket would become
   * an undocumented manual action that fails at the first upload. Doing it in
   * the app means one code path that runs everywhere it needs to and is
   * covered by the API's own tests. It also avoids a one-shot service that
   * sits in `docker compose ps` permanently marked "exited".
   *
   * It never blocks boot. A deployment whose credentials may only read and
   * write objects — the right grant for production — will fail here, and that
   * is not a reason to refuse to start: /health then reports storage honestly,
   * which is more useful than a crash loop.
   */
  async onModuleInit(): Promise<void> {
    const bucket = this.bucket();

    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));

      return;
    } catch {
      // Missing, or unreadable — either way, try to create it below.
    }

    try {
      await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      // Nothing sets a public-read policy: a bucket of someone's voice memos
      // is private, and reads go through the API, which knows who is asking.
      this.logger.log(`Created private bucket "${bucket}"`);
    } catch (error) {
      this.logger.warn(
        `Could not ensure bucket "${bucket}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The bucket media is stored in. */
  bucket(): string {
    return process.env.MINIO_BUCKET ?? 'voice-memos';
  }

  /**
   * Round-trips a HEAD against the bucket.
   *
   * Deliberately bucket-scoped rather than a liveness ping: a reachable
   * storage server whose bucket is missing or unreadable cannot serve an
   * upload, and reporting that as healthy would move the failure to the first
   * user request.
   */
  async ping(): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: this.bucket() }));
  }

  /** Stores an object under `key`. */
  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket(),
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /**
   * Reads an object back into memory.
   *
   * Buffered rather than streamed on purpose: uploads are capped at
   * {@link MAX_AUDIO_UPLOAD_BYTES}, and the provider call downstream wants the
   * whole body anyway to build a multipart form. Streaming would buy nothing
   * and cost a partial-read failure mode.
   */
  async get(key: string): Promise<{ body: Buffer; contentType: string }> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket(), Key: key }),
    );

    if (response.Body === undefined) {
      throw new Error(`Object "${key}" has no body`);
    }

    return {
      body: Buffer.from(await response.Body.transformToByteArray()),
      // What the client declared at upload; the pipeline needs it to tell the
      // provider which container format it is being handed.
      contentType: response.ContentType ?? 'application/octet-stream',
    };
  }

  /** Closes the underlying HTTP sockets so the process can exit. */
  onModuleDestroy(): void {
    this.client.destroy();
  }
}
