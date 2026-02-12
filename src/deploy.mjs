import * as core from "@actions/core";
import "@heyputer/puter.js/dist/puter.cjs";
import fs from "node:fs/promises";
import path from "node:path";

const NOT_FOUND_CODES = new Set(["entity_not_found", "not_found"]);
const ALREADY_EXISTS_CODES = new Set(["already_exists", "entity_exists", "file_exists", "exists", "directory_exists"]);

function safeJSON(value) {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function isNotFoundError(error) {
    const code = error?.error?.code ?? error?.code;
    if (code && NOT_FOUND_CODES.has(String(code).toLowerCase())) {
        return true;
    }

    const status = error?.error?.status ?? error?.status;
    if (status === 404) {
        return true;
    }

    const message = [
        error?.error?.message,
        error?.message,
        typeof error === "string" ? error : "",
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    return message.includes("not found") || message.includes("no entry found");
}

function isAlreadyExistsError(error) {
    const code = error?.error?.code ?? error?.code;
    if (code && ALREADY_EXISTS_CODES.has(String(code).toLowerCase())) {
        return true;
    }

    const message = [
        error?.error?.message,
        error?.message,
        typeof error === "string" ? error : "",
    ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

    return message.includes("already exists");
}

function isDirectoryMetadata(entry) {
    if (!entry || typeof entry !== "object") {
        return false;
    }

    if (entry.isDirectory === true || entry.is_dir === true || entry.isDir === true) {
        return true;
    }

    const type = String(entry.type ?? entry.kind ?? entry.entry_type ?? "").toLowerCase();
    return type === "directory" || type === "dir" || type === "folder";
}

function joinPuterPath(basePath, relativePath = "") {
    const normalizedBase = String(basePath).replace(/\\/g, "/").replace(/\/+$/, "");
    const normalizedRelative = String(relativePath).replace(/\\/g, "/").replace(/^\/+/, "");

    if (!normalizedRelative) return normalizedBase;
    if (!normalizedBase) return normalizedRelative;
    return `${normalizedBase}/${normalizedRelative}`;
}

async function pathExists(targetPath) {
    try {
        await fs.access(targetPath);
        return true;
    } catch {
        return false;
    }
}

async function collectFiles(sourcePath, includeHidden) {
    const sourceStat = await fs.lstat(sourcePath);
    const files = [];

    const shouldSkipName = (name) => !includeHidden && name.startsWith(".");

    if (sourceStat.isFile()) {
        files.push({
            absolutePath: sourcePath,
            relativePath: path.basename(sourcePath),
        });
        return files;
    }

    if (!sourceStat.isDirectory()) {
        throw new Error(`source_path must be a file or directory. Received: ${sourcePath}`);
    }

    async function walk(currentPath) {
        const entries = await fs.readdir(currentPath, { withFileTypes: true });

        for (const entry of entries) {
            if (shouldSkipName(entry.name)) {
                continue;
            }

            const absoluteEntryPath = path.join(currentPath, entry.name);
            if (entry.isDirectory()) {
                await walk(absoluteEntryPath);
                continue;
            }

            if (entry.isFile()) {
                files.push({
                    absolutePath: absoluteEntryPath,
                    relativePath: path.relative(sourcePath, absoluteEntryPath),
                });
                continue;
            }

            if (entry.isSymbolicLink()) {
                core.info(`Skipping symlink: ${absoluteEntryPath}`);
            }
        }
    }

    await walk(sourcePath);
    return files;
}

async function ensureRemoteDirectory(puter, puterPath) {
    try {
        const existing = await puter.fs.stat(puterPath);
        if (!isDirectoryMetadata(existing)) {
            throw new Error(`Puter path exists but is not a directory: ${puterPath}. stat=${safeJSON(existing)}`);
        }
        return existing;
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }
    }

    try {
        await puter.fs.mkdir(puterPath, { createMissingParents: true });
    } catch (error) {
        if (!isAlreadyExistsError(error)) {
            throw error;
        }

        // mkdir may fail due to races/exists; stat() below is the source of truth.
        core.info(`mkdir reported existing directory, rechecking target: ${safeJSON(error)}`);
    }

    const created = await puter.fs.stat(puterPath);
    if (!isDirectoryMetadata(created)) {
        throw new Error(`Failed to create Puter directory: ${puterPath}. stat=${safeJSON(created)}`);
    }
    return created;
}

async function withConcurrency(items, limit, worker) {
    if (!items.length) {
        return;
    }

    const bounded = Math.max(1, Math.min(limit, items.length));
    let nextIndex = 0;
    let completed = 0;

    const runners = Array.from({ length: bounded }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) {
                return;
            }

            await worker(items[index], index);
            completed += 1;

            if (completed % 25 === 0 || completed === items.length) {
                core.info(`Uploaded ${completed}/${items.length} files`);
            }
        }
    });

    await Promise.all(runners);
}

async function ensureSubdomainBinding(puter, subdomain, puterPath, desiredRootUid) {
    let current;
    try {
        current = await puter.hosting.get(subdomain);
    } catch (error) {
        if (!isNotFoundError(error)) {
            throw error;
        }

        const created = await puter.hosting.create(subdomain, puterPath);
        return { action: "created", site: created };
    }

    if (current?.root_dir?.uid === desiredRootUid) {
        return { action: "unchanged", site: current };
    }

    const updated = await puter.hosting.update(subdomain, puterPath);
    return { action: "updated", site: updated };
}

function initPuterFromBundle(token) {
    const puter = globalThis.puter;
    if (!puter || typeof puter.setAuthToken !== "function") {
        throw new Error("Failed to initialize Puter SDK from bundled runtime.");
    }

    puter.setAuthToken(token);
    return puter;
}

async function run() {
    const subdomain = core.getInput("subdomain", { required: true }).trim();
    const puterPath = core.getInput("puter_path", { required: true }).trim();
    const token = core.getInput("puter_token", { required: true }).trim();
    const sourcePathInput = core.getInput("source_path") || ".";
    const includeHidden = core.getBooleanInput("include_hidden");
    const concurrencyInput = Number.parseInt(core.getInput("concurrency") || "8", 10);
    const concurrency = Number.isFinite(concurrencyInput) && concurrencyInput > 0 ? concurrencyInput : 8;
    const workspace = process.env.GITHUB_WORKSPACE || process.cwd();
    const sourcePath = path.resolve(workspace, sourcePathInput);

    if (!subdomain) {
        throw new Error("Input 'subdomain' cannot be empty.");
    }
    if (!puterPath) {
        throw new Error("Input 'puter_path' cannot be empty.");
    }
    if (!token) {
        throw new Error("Input 'puter_token' cannot be empty.");
    }

    const sourceExists = await pathExists(sourcePath);
    if (!sourceExists) {
        throw new Error(`source_path does not exist: ${sourcePath}`);
    }

    core.info(`Source path: ${sourcePath}`);
    core.info(`Puter path: ${puterPath}`);
    core.info(`Subdomain: ${subdomain}`);

    const puter = initPuterFromBundle(token);
    const rootDir = await ensureRemoteDirectory(puter, puterPath);
    const files = await collectFiles(sourcePath, includeHidden);

    core.info(`Discovered ${files.length} file(s) to upload`);

    await withConcurrency(files, concurrency, async (file) => {
        const relativePosix = file.relativePath.split(path.sep).join("/");
        const remoteFilePath = joinPuterPath(puterPath, relativePosix);
        const data = await fs.readFile(file.absolutePath);

        await puter.fs.write(remoteFilePath, data, {
            overwrite: true,
            dedupeName: false,
            createMissingParents: true,
        });
    });

    const binding = await ensureSubdomainBinding(puter, subdomain, puterPath, rootDir.uid);
    const deployedSubdomain = binding.site?.subdomain ?? subdomain.split(".")[0];
    const deploymentURL = `https://${deployedSubdomain}.puter.site`;

    core.setOutput("deployed_files", String(files.length));
    core.setOutput("deployment_url", deploymentURL);
    core.setOutput("binding_action", binding.action);

    core.info(`Binding action: ${binding.action}`);
    core.info(`Deployment URL: ${deploymentURL}`);
}

run().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    core.setFailed(message);
});
