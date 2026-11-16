import { App } from 'aws-cdk-lib';
import { DocumentIngestionStack } from '../lib/document-ingestion-stack';

const app = new App();

new DocumentIngestionStack(app, 'DocumentIngestionStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1',
  },
  allowedUploadOrigins: (process.env.UPLOAD_ORIGINS ?? 'https://app.example.com').split(','),
  workerType: process.env.WORKER_TYPE === 'lambda' ? 'lambda' : 'ecs',
});
