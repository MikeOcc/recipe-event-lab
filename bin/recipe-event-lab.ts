#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { RecipeEventLabStack } from '../lib/recipe-event-lab-stack';

const app = new cdk.App();
new RecipeEventLabStack(app, 'RecipeEventLabStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-1',
  },
});
