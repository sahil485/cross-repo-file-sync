import * as core from '@actions/core';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import * as github from '@actions/github';
import { RestEndpointMethodTypes } from '@octokit/plugin-rest-endpoint-methods';

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

async function getDiffFiles(baseRef: string): Promise<DiffFile[]> {
  const token = core.getInput('token') || process.env.GITHUB_TOKEN;

  if (!token) {
    throw new Error('GitHub token is required');
  }

  const octokit = github.getOctokit(token);
  
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
      updated.push(spec); // no change
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

async function autoCommitAndPushIfChanged(): Promise<void> {
  const token = core.getInput('github-token', { required: true });
  const octokit = github.getOctokit(token);
  
  // Check if we're in a PR from a fork
  const isFork =
    github.context.payload.pull_request?.head.repo.full_name !== github.context.repo.owner + '/' + github.context.repo.repo;

  if (isFork) {
    core.warning('Skipping commit: PR is from a fork and push is not allowed.');
    return;
  }
  
  // Read the file content
  const content = fs.readFileSync(CONFIG_PATH, 'utf-8');
  
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
    await octokit.rest.repos.createOrUpdateFileContents({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      path: CONFIG_PATH,
      message: 'chore: auto-update openapi-sync.yml based on renamed/deleted OpenAPI files',
      content: Buffer.from(content).toString('base64'),
      sha: fileSha,
      branch: github.context.ref.replace('refs/heads/', ''),
      committer: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
      author: {
        name: 'github-actions[bot]',
        email: '41898282+github-actions[bot]@users.noreply.github.com',
      },
    });
    
    core.info('Changes committed and pushed.');
  } catch (error: any) {
    // If the file doesn't exist yet, create it
    if (error.status === 404) {
      await octokit.rest.repos.createOrUpdateFileContents({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        path: CONFIG_PATH,
        message: 'chore: create openapi-sync.yml',
        content: Buffer.from(content).toString('base64'),
        branch: github.context.ref.replace('refs/heads/', ''),
        committer: {
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
        },
        author: {
          name: 'github-actions[bot]',
          email: '41898282+github-actions[bot]@users.noreply.github.com',
        },
      });
      
      core.info('File created and committed.');
    } else {
      throw error;
    }
  }
}

async function run(): Promise<void> {
  try {
    const baseRef = process.env.GITHUB_BASE_REF;
    if (!baseRef) {
      core.setFailed('GITHUB_BASE_REF not found. Are you running in a PR context?');
      return;
    }

    if (!fs.existsSync(CONFIG_PATH)) {
      core.setFailed(`Config file not found at ${CONFIG_PATH}`);
      return;
    }

    const configRaw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const config = yaml.load(configRaw) as Record<string, any>;

    const openapiMapping = config?.jobs?.sync?.steps?.find(
        (step: any) => step.with?.openapi
    )?.with?.openapi;
      
    core.info(`OpenAPI: ${JSON.stringify(openapiMapping)}`);
      
    if (!openapiMapping) {
      core.setFailed('Missing openapi block in sync job');
      return;
    }

    const changes = await getDiffFiles(baseRef);
    const specs = parseOpenAPIBlock(openapiMapping);
    const updatedSpecs = updateSpecs(specs, changes);

    config.jobs.sync.with.openapi = formatOpenAPIBlock(updatedSpecs);

    const updatedYaml = yaml.dump(config, { lineWidth: -1 });
    fs.writeFileSync(CONFIG_PATH, updatedYaml);

    await autoCommitAndPushIfChanged();

    core.info('Successfully updated openapi-sync.yml');
  } catch (error: any) {
    core.setFailed(error.message);
  }
}

run();