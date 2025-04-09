import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';
import { GitHub } from '@actions/github/lib/utils';
const CONFIG_PATH = path.join('.github', 'workflows', 'sync-openapi.yml');

type OpenAPISpec = {
  source: string;
  destination: string;
};

type FileStatus = 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
type DiffFile =
  | ['D', string]                         
  | ['R', string, string]
  | undefined;

type CompareCommitsResponse = RestEndpointMethodTypes['repos']['compareCommits']['response'];
type FileEntry = NonNullable<CompareCommitsResponse['data']['files']>[number];

async function getComparisonBaseRef(octokit: InstanceType<typeof GitHub>): Promise<string> {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (!baseRef) {
        throw new Error('GITHUB_BASE_REF not found. Are you running in a PR context?');
    }

    const prNumber = github.context.payload.pull_request?.number;
    if (!prNumber) {
        throw new Error('Pull request number not found in context');
    }

    const { data: commits } = await octokit.rest.pulls.listCommits({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: prNumber,
    });

    // Look for the most recent bot commit with [skip ci] in the message
    const botCommit = [...commits].reverse().find(commit =>
        commit.commit.message.includes('[skip ci]') &&
        commit.author?.login === 'github-actions[bot]'
    );

    if (botCommit) {
        return botCommit.sha;
    }

    // Fallback to base branch commit SHA
    const { data: baseRefData } = await octokit.rest.repos.getBranch({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        branch: baseRef,
    });
    return baseRefData.commit.sha;
}

async function getDiffFiles(baseRef: string, octokit: InstanceType<typeof GitHub>): Promise<DiffFile[]> {  
  // Get the current commit SHA
  const headSha = github.context.sha;
  
  // Get the base commit SHA
  const { data: compareData } = await octokit.rest.repos.compareCommits({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    base: baseRef,
    head: headSha,
  });

  // Transform the files data into the format we need
  return compareData.files?.map((file: FileEntry) => {
    const status = file.status as FileStatus;
    if (status === 'removed') {
      return ['D', file.filename];
    } else if (status === 'renamed') {
      return ['R', file.previous_filename!, file.filename];
    }
  }) || [];
}

function parseOpenAPIBlock(block: string): OpenAPISpec[] {
  const parsed = yaml.load(block);
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed as OpenAPISpec[];
}

function formatOpenAPIBlock(specs: OpenAPISpec[]): string {
  return specs.map(spec => `  - source: ${spec.source}\n    destination: ${spec.destination}`).join('\n');
}

function updateSpecs(specs: OpenAPISpec[], changes: DiffFile[]): OpenAPISpec[] {
  const updated: OpenAPISpec[] = [];

  for (const spec of specs) {
    const change = changes.find(c => {
        if (c) {
            return (c[0] === 'R' && c[1] === spec.source) || (c[0] === 'D' && c[1] === spec.source)
        }
    });

    if (!change) {
      updated.push(spec);
      continue;
    }

    if (change[0] === 'D') {
      core.info(`Removing deleted source: ${spec.source}`);
      continue;
    }

    if (change[0] === 'R') {
      const [, oldPath, newPath] = change;
      if (!newPath) {
        core.warning(`Missing new path for renamed file: ${oldPath}`);
        continue;
      }
      core.info(`Updating renamed source: ${oldPath} -> ${newPath}`);
      updated.push({
        source: newPath,
        destination: spec.destination.replace(path.basename(spec.source), path.basename(newPath)),
      });
    }
  }

  return updated;
}

type GetContentResponse = RestEndpointMethodTypes['repos']['getContent']['response'];
type FileData = {
  type: 'file';
  sha: string;
  content?: string;
  [key: string]: any;
};

async function autoCommitAndPushIfChanged(octokit: InstanceType<typeof GitHub>): Promise<void> {
    const isFork =
        github.context.payload.pull_request?.head.repo.full_name !== github.context.repo.owner + '/' + github.context.repo.repo;

  if (isFork) {
    core.warning('Skipping commit: PR is from a fork and push is not allowed.');
    return;
  }
  
  // Read the file content
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const branch = github.context.payload.pull_request?.head.ref || process.env.GITHUB_HEAD_REF;

  try {
    // Get the current file to check if it exists and get its SHA
    const response = await octokit.rest.repos.getContent({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: CONFIG_PATH,
      ref: github.context.sha,
    });
    
    const fileData = response.data as FileData;
    
    if (fileData.type !== 'file') {
      throw new Error('Path exists but is not a file');
    }
    
    const fileSha = fileData.sha;
    // Update the file
    if (!branch) {
      throw new Error('Could not find branch for PR.');
    }

    await octokit.rest.repos.createOrUpdateFileContents({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: CONFIG_PATH,
        message: 'chore: auto-update renamed/deleted files referenced in openapi-sync.yml [skip ci]',
        content: Buffer.from(content).toString('base64'),
        sha: fileSha,
        branch,
        committer: {
            name: 'github-actions',
            email: 'github-actions@github.com',
        },
        author: {
            name: 'github-actions',
            email: 'github-actions@github.com',
        },
    });
    
    core.info('Changes committed and pushed.');
  } catch (error: any) {
        throw error;
  }
}

async function run(): Promise<void> {
  try {

    if (!fs.existsSync(CONFIG_PATH)) {
      core.setFailed(`Config file not found at ${CONFIG_PATH}`);
      return;
    }

    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = yaml.load(configRaw) as Record<string, any>;

    const syncStep = config.jobs.sync.steps?.find((step: any) => step.with?.openapi);
    if (!syncStep.with) {
    syncStep.with = {};
    }

    const openapiMapping = syncStep?.with?.openapi;
            
    if (!openapiMapping) {
      core.setFailed('Missing openapi block in sync job');
      return;
    }


    const token = core.getInput('token') || process.env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('GitHub token is required');
    }
    const octokit: InstanceType<typeof GitHub> = github.getOctokit(token);

    const baseRef = await getComparisonBaseRef(octokit);

    const specs = parseOpenAPIBlock(openapiMapping);

    if (specs.length === 0) {
        core.info('No tracked files, skipping update.');
        return;
    }

    let changes = await getDiffFiles(baseRef, octokit);
    changes = changes.filter(Boolean);

    core.info("changes: " + JSON.stringify(changes));
    return;

    if (changes.length === 0) {
      core.info('No tracked files renamed/deleted, skipping update.');
      return;
    }

    const updatedSpecs = updateSpecs(specs, changes);

    syncStep.with.openapi = formatOpenAPIBlock(updatedSpecs);

    const updatedYaml = yaml.dump(config, { lineWidth: -1 });
    fs.writeFileSync(CONFIG_PATH, updatedYaml);
    await autoCommitAndPushIfChanged(octokit);

    core.info('Successfully updated openapi-sync.yml');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();