import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DocumentIngestionStack, type DocumentIngestionStackProps } from '../infra/lib/document-ingestion-stack';

function synth(props: Partial<DocumentIngestionStackProps> = {}) {
  const app = new App();
  const stack = new DocumentIngestionStack(app, 'TestStack', {
    env: { account: '123456789012', region: 'eu-west-1' },
    allowedUploadOrigins: ['https://app.example.com'],
    ...props,
  });
  return Template.fromStack(stack);
}

/** Every statement in every policy document attached to the worker role. */
function workerStatements(template: Template): any[] {
  const policies = template.findResources('AWS::IAM::ManagedPolicy', {
    Properties: { Description: 'Least-privilege access for the document ingestion worker' },
  });
  return Object.values(policies).flatMap((p: any) => p.Properties.PolicyDocument.Statement);
}

describe('DocumentIngestionStack', () => {
  const template = synth();

  describe('S3 bucket', () => {
    it('is KMS-encrypted with a rotating customer-managed key', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({
              BucketKeyEnabled: true,
              ServerSideEncryptionByDefault: Match.objectLike({ SSEAlgorithm: 'aws:kms' }),
            }),
          ],
        },
      });
      template.hasResourceProperties('AWS::KMS::Key', { EnableKeyRotation: true });
    });

    it('blocks all public access and disables ACLs', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
        OwnershipControls: { Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }] },
      });
    });

    it('denies non-TLS requests', () => {
      template.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Deny',
              Condition: { Bool: { 'aws:SecureTransport': 'false' } },
            }),
          ]),
        },
      });
    });

    it('allows CORS uploads only from the configured origins', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        CorsConfiguration: {
          CorsRules: [
            Match.objectLike({
              AllowedOrigins: ['https://app.example.com'],
              AllowedMethods: Match.arrayWith(['PUT', 'POST']),
              ExposedHeaders: ['ETag'],
            }),
          ],
        },
      });
    });

    it('is retained when the stack is deleted', () => {
      template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    });

    it('refuses a wildcard CORS origin', () => {
      expect(() => synth({ allowedUploadOrigins: ['*'] })).toThrow(/explicit origins/);
      expect(() => synth({ allowedUploadOrigins: [] })).toThrow(/explicit origins/);
    });
  });

  describe('SQS', () => {
    it('has an encrypted ingestion queue with a dead-letter queue', () => {
      template.resourceCountIs('AWS::SQS::Queue', 2);
      template.hasResourceProperties('AWS::SQS::Queue', {
        SqsManagedSseEnabled: true,
        VisibilityTimeout: 900,
        ReceiveMessageWaitTimeSeconds: 20,
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 5 }),
      });
    });

    it('receives S3 object-created events for the upload prefix', () => {
      template.hasResourceProperties('Custom::S3BucketNotifications', {
        NotificationConfiguration: {
          QueueConfigurations: [
            Match.objectLike({
              Events: ['s3:ObjectCreated:*'],
              Filter: { Key: { FilterRules: [{ Name: 'prefix', Value: 'tenants/' }] } },
            }),
          ],
        },
      });
    });
  });

  describe('worker IAM policy (least privilege)', () => {
    const statements = workerStatements(template);
    const actions = statements.flatMap((s) => [s.Action].flat());

    it('grants exactly the read, decrypt and consume actions', () => {
      expect(actions.sort()).toEqual(
        [
          'kms:Decrypt',
          's3:GetObject',
          's3:GetObjectVersion',
          'sqs:ChangeMessageVisibility',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:GetQueueUrl',
          'sqs:ReceiveMessage',
        ].sort(),
      );
    });

    it('has no wildcards in actions and no write/delete on S3', () => {
      expect(actions.some((a) => a.includes('*'))).toBe(false);
      expect(actions.some((a) => /^s3:(Put|Delete)/.test(a))).toBe(false);
      expect(actions).not.toContain('sqs:SendMessage');
    });

    it('scopes S3 reads to objects under the upload prefix', () => {
      const s3Statement = statements.find((s) => s.Sid === 'ReadTenantUploads');
      expect(JSON.stringify(s3Statement.Resource)).toContain('/tenants/*');
    });

    it('only allows KMS decrypt when called through S3', () => {
      const kms = statements.find((s) => s.Sid === 'DecryptViaS3Only');
      expect(kms.Condition).toEqual({ StringEquals: { 'kms:ViaService': 's3.eu-west-1.amazonaws.com' } });
    });

    it('scopes SQS permissions to the ingestion queue only', () => {
      const sqs = statements.find((s) => s.Sid === 'ConsumeIngestionQueue');
      expect(sqs.Resource).toEqual({ 'Fn::GetAtt': [expect.stringMatching(/^IngestionQueue/), 'Arn'] });
    });
  });

  describe('worker role', () => {
    it('is assumable by ECS tasks by default', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'ecs-tasks.amazonaws.com' } })],
        },
      });
    });

    it('is assumable by Lambda (with basic logging) when workerType is lambda', () => {
      const lambda = synth({ workerType: 'lambda' });
      lambda.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [Match.objectLike({ Principal: { Service: 'lambda.amazonaws.com' } })],
        },
        ManagedPolicyArns: Match.arrayWith([
          Match.objectLike({ 'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('AWSLambdaBasicExecutionRole')])]) }),
        ]),
      });
    });
  });
});
