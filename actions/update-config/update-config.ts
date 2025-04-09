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


// async function getDiffFiles(baseRef: string, octokit: InstanceType<typeof GitHub>): Promise<DiffFile[]> {  
//   // Get the current commit SHA
//   const headSha = github.context.sha;
  
//   // Get the base commit SHA
//   const { data: compareData } = await octokit.rest.repos.compareCommits({
//     owner: github.context.repo.owner,
//     repo: github.context.repo.repo,
//     base: baseRef,
//     head: headSha,
//   });

//   // Transform the files data into the format we need
//   return compareData.files?.map((file: FileEntry) => {
//     const status = file.status as FileStatus;
//     if (status === 'removed') {
//       return ['D', file.filename];
//     } else if (status === 'renamed') {
//       return ['R', file.previous_filename!, file.filename];
//     }
//   }) || [];
// }

async function getDiffFiles(baseRef: string, specs: OpenAPISpec[]): Promise<DiffFile[]> {
    // Track both forward and reverse mappings
    const sourceToCurrentMap = new Map<string, string | null>();
    const currentToSourceMap = new Map<string, string>();
    
    // Initialize maps with all source files from specs
    for (const spec of specs) {
      sourceToCurrentMap.set(spec.source, spec.source);
      currentToSourceMap.set(spec.source, spec.source);
    }
    
    // Build path list from specs
    const specPaths = specs.map(spec => spec.source);
    
    // Split the command to handle command length limits
    const baseCommand = [
      "git", 
      "log", 
      `${baseRef}..HEAD`, 
      "--name-status", 
      "--diff-filter=RD", 
      "--pretty=format:%H%n"
    ];
    
    // Process files in batches to avoid command line length limits
    const BATCH_SIZE = 50;
    let changesOutput = '';
    
    // Process files in batches
    for (let i = 0; i < specPaths.length; i += BATCH_SIZE) {
      const pathBatch = specPaths.slice(i, i + BATCH_SIZE);
      
      // Combine the base command with the current batch of paths
      const fullCommand = [...baseCommand, "--", ...pathBatch];
      
      // Execute the command for this batch
      let batchOutput = '';
      await exec.exec(fullCommand[0], fullCommand.slice(1), {
        listeners: {
          stdout: (data: Buffer) => {
            batchOutput += data.toString();
          }
        },
        silent: true
      });
      
      changesOutput += batchOutput;
    }
    
    // Process the output in chunks of commit data
    const commitChunks = changesOutput.trim().split(/^[0-9a-f]{40}$/m).filter(Boolean);
    
    for (const chunk of commitChunks) {
      // Extract file changes from this commit
      const lines = chunk.trim().split('\n').filter(line => line.match(/^[RD]\d*\t/));
      
      for (const line of lines) {
        const parts = line.split('\t');
        
        if (line.startsWith('R')) {
          // Handle rename
          if (parts.length >= 3) {
            const oldPath = parts[1];
            const newPath = parts[2];
            
            // Check if we're tracking this file
            const source = currentToSourceMap.get(oldPath);
            if (source) {
              // Update the mappings for this file
              sourceToCurrentMap.set(source, newPath);
              currentToSourceMap.delete(oldPath);
              currentToSourceMap.set(newPath, source);
            }
          }
        } else if (line.startsWith('D')) {
          // Handle deletion
          if (parts.length >= 2) {
            const path = parts[1];
            
            // Check if we're tracking this file
            const source = currentToSourceMap.get(path);
            if (source) {
              // Mark as deleted
              sourceToCurrentMap.set(source, null);
              currentToSourceMap.delete(path);
            }
          }
        }
      }
    }
    
    // Convert the final state map to the required output format
    const diffFiles: DiffFile[] = [];
    for (const [source, finalPath] of sourceToCurrentMap.entries()) {
      if (finalPath === null) {
        diffFiles.push(['D', source]);
      } else if (finalPath !== source) {
        diffFiles.push(['R', source, finalPath]);
      }
    }
    
    return diffFiles;
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

    let changes = await getDiffFiles(baseRef, specs);
    changes = changes.filter(Boolean);

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