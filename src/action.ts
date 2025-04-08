import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

interface OpenAPIMapping {
  source: string;
  destination: string;
}

interface SyncOptions {
  repository: string;
  openapi: OpenAPIMapping[];
  token?: string;
  branch?: string;
  autoMerge?: boolean;
}

export async function run(): Promise<void> {
  try {
    const repository = core.getInput('repository', { required: true });
    const token = core.getInput('token') || process.env.GITHUB_TOKEN;
    const branch = core.getInput('branch') || 'update-openapi';
    const autoMerge = core.getBooleanInput('auto_merge') || false;
    
    const openApiInput = core.getInput('openapi', { required: true });
    let openapi: OpenAPIMapping[];
    
    try {
      openapi = yaml.load(openApiInput) as OpenAPIMapping[];
    } catch (yamlError) {
      try {
        openapi = JSON.parse(openApiInput) as OpenAPIMapping[];
      } catch (jsonError) {
        throw new Error(`Failed to parse 'openapi' input as either YAML or JSON. Please check the format. Error: ${(yamlError as Error).message}`);
      }
    }
    
    if (!Array.isArray(openapi) || openapi.length === 0) {
      throw new Error('OpenAPI mapping must be a non-empty array');
    }
    
    for (const [index, mapping] of openapi.entries()) {
      if (!mapping.source || !mapping.destination) {
        throw new Error(`OpenAPI mapping at index ${index} is missing required 'source' or 'destination' field`);
      }
    }
    
    const options: SyncOptions = {
      repository,
      openapi,
      token,
      branch,
      autoMerge
    };    
    await cloneRepository(options);
    
    const createPR = await copyOpenAPIFiles(options);
    
    if (createPR) {
      await createPullRequest(options);
    } else {
      core.info('Source files not found. Skipping pull request creation.');
    }
    
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed('An unknown error occurred');
    }
  }
}

async function cloneRepository(options: SyncOptions): Promise<void> {
  if (!options.token) {
    throw new Error('GitHub token is required to authenticate and clone the repository. Please provide a token with appropriate permissions.');
  }

  try {
    const octokit = github.getOctokit(options.token);
    const [owner, repo] = options.repository.split('/');
    
    await octokit.rest.repos.get({
      owner,
      repo
    });
    
    core.info('Successfully authenticated with the target repository');
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes('Not Found')) {
        throw new Error(`Repository ${options.repository} not found or you don't have permission to access it. Please check the repository name and ensure your token has the required permissions.`);
      } else if (error.message.includes('Bad credentials')) {
        throw new Error('Authentication failed. Please check that your token is valid and has not expired.');
      } else {
        throw new Error(`Failed to verify repository access: ${error.message}`);
      }
    } else {
      throw new Error('An unknown error occurred while verifying repository access');
    }
  }

  const repoUrl = `https://x-access-token:${options.token}@github.com/${options.repository}.git`;
  const repoDir = 'fern-config';
  
  core.info(`Cloning repository ${options.repository} to ${repoDir}`);
  
  await io.mkdirP(repoDir);
  
  try {
    await exec.exec('git', ['clone', repoUrl, repoDir]);
  } catch (error) {
    throw new Error(`Failed to clone repository. Please ensure your token has 'repo' scope and you have write access to ${options.repository}.`);
  }
  
  process.chdir(repoDir);
  await exec.exec('git', ['config', 'user.name', 'github-actions']);
  await exec.exec('git', ['config', 'user.email', 'github-actions@github.com']);
  
  await exec.exec('git', ['checkout', '-b', options.branch!]);
}

async function copyOpenAPIFiles(options: SyncOptions): Promise<boolean> {
    core.info('Copying OpenAPI files to destination locations');
    
    const sourceRepoRoot = path.resolve(process.env.GITHUB_WORKSPACE || '');
    const destRepoRoot = path.resolve('.');

    let fileUpdated = false;
    
    for (const mapping of options.openapi) {
      const sourcePath = path.join(sourceRepoRoot, mapping.source);
      const destPath = path.join(destRepoRoot, mapping.destination);
      
      core.info(`Checking for source file: ${sourcePath}`);
      
      if (!fs.existsSync(sourcePath)) {
        core.info(`Source file not found: ${mapping.source}`);
        core.info(`Skipping ${mapping.source}`);
      } else {
        core.info(`Copying ${sourcePath} to ${destPath}`);        
        await io.mkdirP(path.dirname(destPath));
        fs.copyFileSync(sourcePath, destPath);
        core.info(`Copied ${sourcePath} to ${destPath}`);
        fileUpdated = true;
    }
  }

  return fileUpdated;
}

// Check if a branch exists in the remote repository
async function branchExists(owner: string, repo: string, branchName: string, octokit: any): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`
    });
    return true;
  } catch (error) {
    return false; // Assume any error means branch doesn't exist
  }
}

// Set up the branch (create or update)
async function setupBranch(branchName: string, exists: boolean): Promise<void> {
  if (exists) {
    core.info(`Branch ${branchName} exists. Updating it.`);
    await exec.exec('git', ['checkout', '-b', branchName, 'origin/main']);
  } else {
    core.info(`Branch ${branchName} does not exist. Creating it.`);
    await exec.exec('git', ['checkout', '-b', branchName]);
  }
}

// Check for and commit changes
async function commitChanges(): Promise<boolean> {
  const diff = await exec.getExecOutput('git', ['status', '--porcelain']);
  
  if (!diff.stdout.trim()) {
    core.info('No changes detected. Skipping PR creation.');
    return false;
  }
  
  await exec.exec('git', ['add', '.']);
  await exec.exec('git', ['commit', '-m', 'Update OpenAPI specifications']);
  return true;
}

// Push changes to the branch
async function pushChanges(branchName: string): Promise<void> {
  try {
    await exec.exec('git', ['push', '--force', 'origin', branchName]);
  } catch (error) {
    throw new Error(`Failed to push changes to the repository: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Check if a PR exists for a branch
async function prExists(owner: string, repo: string, branchName: string, octokit: any): Promise<number | null> {
  const prs = await octokit.rest.pulls.list({
    owner,
    repo,
    head: `${owner}:${branchName}`,
    state: 'open'
  });
  
  return prs.data.length > 0 ? prs.data[0].number : null;
}

// Update an existing PR
async function updatePR(octokit: any, owner: string, repo: string, prNumber: number): Promise<void> {
  core.info(`Updating PR #${prNumber}`);
  
  await octokit.rest.pulls.update({
    owner,
    repo,
    pull_number: prNumber,
    body: `Update OpenAPI specifications based on changes in the source repository.\nUpdated: ${new Date().toISOString()}`
  });
}

// Create a new PR
async function createPR(octokit: any, owner: string, repo: string, branchName: string): Promise<any> {
  core.info(`Creating new PR for branch ${branchName}`);
  
  const prResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title: 'Update OpenAPI specifications',
    head: branchName,
    base: 'main',
    body: 'Update OpenAPI specifications based on changes in the source repository.'
  });
  
  core.info(`Pull request created: ${prResponse.data.html_url}`);
  return prResponse;
}

// Auto-merge a PR
async function autoMergePR(octokit: any, owner: string, repo: string, prNumber: number): Promise<void> {
  core.info('Attempting to auto-merge pull request');
  
  try {
    await octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: prNumber,
      merge_method: 'squash'
    });
    core.info('Pull request auto-merged successfully');
  } catch (error) {
    core.warning('Failed to auto-merge pull request.');
  }
}

// Main function
async function createPullRequest(options: SyncOptions): Promise<void> {
  if (!options.token) {
    core.warning('GitHub token not provided. Skipping PR creation.');
    return;
  }
  
  const octokit = github.getOctokit(options.token);
  const [owner, repo] = options.repository.split('/');
  const branchName = options.branch!;
  
  try {
    // Check if branch exists and set it up
    const doesBranchExist = await branchExists(owner, repo, branchName, octokit);
    await setupBranch(branchName, doesBranchExist);
    
    // Commit changes if there are any
    const hasChanges = await commitChanges();
    if (!hasChanges) return;
    
    // Push changes to the branch
    await pushChanges(branchName);
    
    // Handle PR (create or update)
    const existingPRNumber = await prExists(owner, repo, branchName, octokit);
    
    let prNumber: number;
    if (existingPRNumber) {
      await updatePR(octokit, owner, repo, existingPRNumber);
      prNumber = existingPRNumber;
    } else {
      const prResponse = await createPR(octokit, owner, repo, branchName);
      prNumber = prResponse.data.number;
    }
    
    // Auto-merge if configured
    if (options.autoMerge) {
      await autoMergePR(octokit, owner, repo, prNumber);
    }
  } catch (error) {
    throw new Error(`Failed to create or update PR: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

run();