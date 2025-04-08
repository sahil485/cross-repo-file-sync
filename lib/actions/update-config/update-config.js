"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const core = __importStar(require("@actions/core"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const yaml = __importStar(require("js-yaml"));
const github = __importStar(require("@actions/github"));
const CONFIG_PATH = path.join('.github', 'workflows', 'openapi-sync.yml');
async function getDiffFiles(baseRef) {
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
    return compareData.files?.map((file) => {
        const status = file.status;
        if (status === 'removed') {
            return ['D', file.filename];
        }
        else if (status === 'renamed') {
            return ['R', file.previous_filename, file.filename];
        }
    }) || [];
}
function parseOpenAPIBlock(block) {
    const parsed = yaml.load(block);
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed;
}
function formatOpenAPIBlock(specs) {
    return specs.map(spec => `  - source: ${spec.source}\n    destination: ${spec.destination}`).join('\n');
}
function updateSpecs(specs, changes) {
    const updated = [];
    for (const spec of specs) {
        const change = changes.find(c => {
            if (c) {
                return (c[0] === 'R' && c[1] === spec.source) || (c[0] === 'D' && c[1] === spec.source);
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
async function autoCommitAndPushIfChanged() {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);
    // Check if we're in a PR from a fork
    const isFork = github.context.payload.pull_request?.head.repo.full_name !== github.context.repo.owner + '/' + github.context.repo.repo;
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
        const fileData = response.data;
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
    }
    catch (error) {
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
        }
        else {
            throw error;
        }
    }
}
async function run() {
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
        const config = yaml.load(configRaw);
        if (!config?.jobs?.sync?.with?.openapi) {
            core.setFailed('Missing openapi block in sync job');
            return;
        }
        const changes = await getDiffFiles(baseRef);
        const openapiBlock = config.jobs.sync.with.openapi;
        core.info(`Changes: ${JSON.stringify(changes)}`);
        core.info(`OpenAPI block: ${openapiBlock}`);
        return;
        const specs = parseOpenAPIBlock(openapiBlock);
        const updatedSpecs = updateSpecs(specs, changes);
        config.jobs.sync.with.openapi = formatOpenAPIBlock(updatedSpecs);
        const updatedYaml = yaml.dump(config, { lineWidth: -1 });
        fs.writeFileSync(CONFIG_PATH, updatedYaml);
        await autoCommitAndPushIfChanged();
        core.info('Successfully updated openapi-sync.yml');
    }
    catch (error) {
        core.setFailed(error.message);
    }
}
run();
