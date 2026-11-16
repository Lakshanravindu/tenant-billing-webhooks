import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

export type WorkerType = 'ecs' | 'lambda';

export interface DocumentIngestionStackProps extends StackProps {
  /** Browser origins allowed to upload directly to S3 with presigned URLs. */
  allowedUploadOrigins: string[];
  /** Which compute runs the ingestion worker. Decides who may assume the role. */
  workerType?: WorkerType;
  /** Key prefix tenants upload under: `${prefix}<tenantId>/<file>`. */
  uploadPrefix?: string;
}

/**
 * Tenant document uploads -> S3 -> SQS -> ingestion worker (ECS task or Lambda).
 *
 *  - S3: KMS-encrypted, no public access, TLS only, versioned, CORS for
 *    presigned browser uploads.
 *  - SQS: ingestion queue with a dead-letter queue; S3 "object created" events
 *    are delivered straight to it.
 *  - IAM: worker role that can only read objects under the upload prefix,
 *    decrypt them through S3, and consume (receive/delete) from the queue.
 */
export class DocumentIngestionStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly queue: sqs.Queue;
  readonly deadLetterQueue: sqs.Queue;
  readonly workerRole: iam.Role;

  constructor(scope: Construct, id: string, props: DocumentIngestionStackProps) {
    super(scope, id, props);

    const uploadPrefix = props.uploadPrefix ?? 'tenants/';
    const workerType = props.workerType ?? 'ecs';

    if (props.allowedUploadOrigins.length === 0 || props.allowedUploadOrigins.includes('*')) {
      throw new Error('allowedUploadOrigins must list explicit origins');
    }

    // ---------------------------------------------------------------- S3 ----
    const documentsKey = new kms.Key(this, 'DocumentsKey', {
      alias: 'alias/tenant-documents',
      description: 'Encrypts tenant document uploads',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    this.bucket = new s3.Bucket(this, 'TenantDocumentsBucket', {
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: documentsKey,
      bucketKeyEnabled: true, // far fewer KMS calls (and cost) per object
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED, // ACLs disabled
      enforceSSL: true,
      versioned: true,
      cors: [
        {
          allowedOrigins: props.allowedUploadOrigins,
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedHeaders: ['content-type', 'content-md5', 'x-amz-*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        { abortIncompleteMultipartUploadAfter: Duration.days(1) },
        { noncurrentVersionExpiration: Duration.days(30) },
      ],
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // --------------------------------------------------------------- SQS ----
    this.deadLetterQueue = new sqs.Queue(this, 'IngestionDLQ', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
    });

    this.queue = new sqs.Queue(this, 'IngestionQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      enforceSSL: true,
      // Must exceed the worker's processing time (parsing + embedding a large
      // PDF), otherwise the message reappears and is processed twice.
      visibilityTimeout: Duration.minutes(15),
      retentionPeriod: Duration.days(4),
      receiveMessageWaitTime: Duration.seconds(20), // long polling
      deadLetterQueue: { queue: this.deadLetterQueue, maxReceiveCount: 5 },
    });

    this.bucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.SqsDestination(this.queue),
      { prefix: uploadPrefix },
    );

    // --------------------------------------------------------------- IAM ----
    this.workerRole = new iam.Role(this, 'IngestionWorkerRole', {
      assumedBy: new iam.ServicePrincipal(workerType === 'lambda' ? 'lambda.amazonaws.com' : 'ecs-tasks.amazonaws.com'),
      description: 'Document ingestion worker: read uploads, consume ingestion queue',
    });

    // Written out by hand rather than bucket.grantRead()/queue.grantConsumeMessages()
    // so the exact actions are visible in review. grantRead() would also add
    // s3:List* and s3:GetBucket*, which the worker doesn't need: it gets the
    // object key from the queue message.
    const workerPolicy = new iam.ManagedPolicy(this, 'IngestionWorkerPolicy', {
      description: 'Least-privilege access for the document ingestion worker',
      statements: [
        new iam.PolicyStatement({
          sid: 'ReadTenantUploads',
          actions: ['s3:GetObject', 's3:GetObjectVersion'],
          resources: [this.bucket.arnForObjects(`${uploadPrefix}*`)],
        }),
        new iam.PolicyStatement({
          sid: 'DecryptViaS3Only',
          actions: ['kms:Decrypt'],
          resources: [documentsKey.keyArn],
          conditions: {
            StringEquals: { 'kms:ViaService': `s3.${this.region}.amazonaws.com` },
          },
        }),
        new iam.PolicyStatement({
          sid: 'ConsumeIngestionQueue',
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl',
          ],
          resources: [this.queue.queueArn],
        }),
      ],
    });
    this.workerRole.addManagedPolicy(workerPolicy);

    if (workerType === 'lambda') {
      // Lambda writes its own logs; ECS tasks log via the execution role instead.
      this.workerRole.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      );
    }

    new CfnOutput(this, 'BucketName', { value: this.bucket.bucketName });
    new CfnOutput(this, 'QueueUrl', { value: this.queue.queueUrl });
    new CfnOutput(this, 'WorkerRoleArn', { value: this.workerRole.roleArn });
  }
}
