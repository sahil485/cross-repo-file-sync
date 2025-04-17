import * as core from '@actions/core';
import * as github from '@actions/github';
import * as exec from '@actions/exec';
import * as io from '@actions/io';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import micromatch from 'micromatch';

interface Source {
  from: string;
  to: string;
  exclude?: string[];
}

interface SyncOptions {
  repository: string;
  sources: Source[];
  token?: string;
  branch?: string;
  autoMerge?: boolean;
}

export async function run(): Promise<void> {
  try {
    const repository = core.getInput('repository', { required: true });
    const token = core.getInput('token') || process.env.GITHUB_TOKEN;
    const branch = core.getInput('branch', { required: true });
    const autoMerge = core.getBooleanInput('auto_merge') || false;
    
    const sourcesInput = core.getInput('sources', { required: true });
    let sources: Source[];
    
    try {
      sources = yaml.load(sourcesInput) as Source[];
    } catch (yamlError) {
      try {
        sources = JSON.parse(sourcesInput) as Source[];
      } catch (jsonError) {
        throw new Error(`Failed to parse 'sources' input as either YAML or JSON. Please check the format. Error: ${(yamlError as Error).message}`);
      }
    }
    
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error('Sources mapping must be a non-empty array');
    }
    
    for (const [index, source] of sources.entries()) {
      if (!source.from || !source.to) {
        throw new Error(`Source mapping at index ${index} is missing required 'from' or 'to' field`);
      }
    }
    
    const options: SyncOptions = {
      repository,
      sources,
      token,
      branch,
      autoMerge
    };    
    await cloneRepository(options);
    
    await syncChanges(options);
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
      throw new Error(`Failed to verify repository access: ${error.message}`);
    } else {
      throw new Error('An unknown error occurred while verifying repository access');
    }
  }

  const repoUrl = `https://x-access-token:${options.token}@github.com/${options.repository}.git`;
  const repoDir = 'temp-fern-config';
  
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
}

async function syncChanges(options: SyncOptions): Promise<void> {
  if (!options.token) {
    core.warning('GitHub token not provided. Skipping changes.');
    return;
  }
  
  const octokit = github.getOctokit(options.token);
  const [owner, repo] = options.repository.split('/');
  
  try {
    const workingBranch = options.branch!;
    
    if (options.autoMerge) {
      core.info(`Auto-merge enabled. Will push directly to branch: ${workingBranch}`);
    } else {
      core.info(`Auto-merge disabled. Will create PR from branch: ${workingBranch} to main`);
    }
    
    const doesBranchExist = await branchExists(owner, repo, workingBranch, octokit);
    await setupBranch(workingBranch, doesBranchExist);

    await copyMappedSources(options);
    
    const diff = await exec.getExecOutput('git', ['status', '--porcelain']);
  
    if (!diff.stdout.trim()) {
      core.info('No changes detected. Skipping further actions.');
      return;
    }
    
    await commitChanges();
    
    const pushedChanges = await pushChanges(workingBranch, options);
    if (!pushedChanges) return;
    
    // Only proceed with PR creation if auto-merge is false
    if (!options.autoMerge) {
      const existingPRNumber = await prExists(owner, repo, workingBranch, octokit);
      
      if (existingPRNumber) {
        await updatePR(octokit, owner, repo, existingPRNumber);
      } else {
        await createPR(octokit, owner, repo, workingBranch, 'main');
      }
    } else {
      core.info(`Changes pushed directly to branch '${workingBranch}' because auto-merge is enabled.`);
    }
  } catch (error) {
    throw new Error(`Failed to sync changes: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

async function branchExists(owner: string, repo: string, branchName: string, octokit: any): Promise<boolean> {
  try {
    await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${branchName}`
    });
    return true;
  } catch (error) {
    return false;
  }
}

async function setupBranch(branchName: string, exists: boolean): Promise<void> {
  try {
    if (exists) {
      core.info(`Branch ${branchName} exists. Checking it out.`);
      await exec.exec('git', ['checkout', branchName]);
    } else {
      core.info(`Branch ${branchName} does not exist. Creating it.`);
      await exec.exec('git', ['checkout', '-b', branchName]);
    }
  } catch (error) {
    throw new Error(`Failed to setup branch ${branchName}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Copy all mapped sources (files or directories) to their destinations
 */
async function copyMappedSources(options: SyncOptions): Promise<void> {
  core.info('Copying mapped sources to destination locations');
  
  const sourceRepoRoot = path.resolve(process.env.GITHUB_WORKSPACE || '');
  const destRepoRoot = path.resolve('.');
  
  for (const source of options.sources) {
    const sourcePath = path.join(sourceRepoRoot, source.from);
    const destPath = path.join(destRepoRoot, source.to);
    
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Source path ${source.from} not found`);
    }
    
    const sourceStats = fs.statSync(sourcePath);
    
    if (sourceStats.isDirectory()) {
      await copyDirectory(sourcePath, destPath, source.exclude);
    } else {
      await copyFile(sourcePath, destPath);
    }
  }
}

/**
 * Copy a file from source to destination
 */
async function copyFile(sourcePath: string, destPath: string): Promise<void> {
  await io.mkdirP(path.dirname(destPath));
  fs.copyFileSync(sourcePath, destPath);
  core.info(`Copied file from ${sourcePath} to ${destPath}`);
}

/**
 * Copy a directory recursively from source to destination
 */
async function copyDirectory(
  sourceDir: string,
  destDir: string,
  excludePaths: string[] = [],
  depth: number = 0
): Promise<void> {
  if (depth > 10) {
    core.warning(`Max recursion depth exceeded at: ${sourceDir}`);
    return;
  }

  await io.mkdirP(destDir);

  const files = fs.readdirSync(sourceDir);

  for (const file of files) {
    const srcPath = path.join(sourceDir, file);
    const dstPath = path.join(destDir, file);

    const relativeSrcPath = path.relative(process.env.GITHUB_WORKSPACE || process.cwd(), srcPath);

    // Skip if path matches any of the exclude patterns
    if (micromatch.isMatch(relativeSrcPath, excludePaths)) {
      core.info(`Skipping excluded path: ${relativeSrcPath}`);
      continue;
    }

    const stats = fs.statSync(srcPath);

    if (stats.isDirectory()) {
      await copyDirectory(srcPath, dstPath, excludePaths, depth + 1);
    } else {
      await copyFile(srcPath, dstPath);
    }
  }

  core.info(`Copied directory from ${sourceDir} to ${destDir}`);
}

async function commitChanges(): Promise<void> {
  await exec.exec('git', ['add', '.'], { silent: true });
  await exec.exec('git', ['commit', '-m', `Sync files from ${github.context.repo.repo}`], { silent: true });
}

async function hasDifferenceWithRemote(branchName: string): Promise<boolean> {
  try {
    await exec.exec('git', ['fetch', 'origin', branchName], { silent: true });
    
    const diff = await exec.getExecOutput('git', ['diff', `HEAD`, `origin/${branchName}`], { silent: true });
    
    return !!diff.stdout.trim();
  } catch (error) {
    core.info(`Could not fetch remote branch, assuming first push: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return true;
  }
}

async function pushChanges(branchName: string, options: SyncOptions): Promise<boolean> {
  try {
    let shouldPush = true;
    
    if (!options.autoMerge) {
      shouldPush = await hasDifferenceWithRemote(branchName);
    }
    
    if (shouldPush) {
      await exec.exec('git', ['push', '--force', 'origin', branchName], { silent: true });
      return true;
    } else {
      core.info(`No differences with remote branch. Skipping push.`);
      return false;
    }
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
    body: `Update file specifications based on changes in the source repository.\nUpdated: ${new Date().toISOString()}`
  });
}

// Create a new PR
async function createPR(octokit: any, owner: string, repo: string, featureBranch: string, targetBranch: string): Promise<any> {
  core.info(`Creating new PR from ${featureBranch} to ${targetBranch}`);
  
  const prResponse = await octokit.rest.pulls.create({
    owner,
    repo,
    title: 'Update synced files',
    head: featureBranch,
    base: targetBranch,
    body: 'Update file specifications based on changes in the source repository.'
  });
  
  core.info(`Pull request created: ${prResponse.data.html_url}`);
  return prResponse;
}

run();