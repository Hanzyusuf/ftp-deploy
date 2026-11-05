import fs from "fs";
import path from "path";
import { randomBytes } from "crypto";
import { pipeline } from "stream/promises";
import * as ftp from "basic-ftp";
import { ZipFile } from "yazl";
import { fileHash } from "./HashDiff";
import { FtpOperations } from "./ftpOperations";
import { getLocalFiles } from "./localFiles";
import { IFtpDeployArguments, IFileList } from "./types";
import { getDefaultSettings, Logger, Timings } from "./utilities";

export interface ArchiveOptions {
    "local-dir"?: string;
    "state-name"?: string;
    exclude?: string[];
}

/** Make a ZIP containing the files and their sync state. */
export async function prepareArchive(output: string, options: ArchiveOptions = {}): Promise<IFileList> {
    const args = getDefaultSettings({ server: "", username: "", password: "", ...options });
    const local = fs.realpathSync(args["local-dir"]);
    const destination = path.resolve(output);
    const parent = fs.realpathSync(path.dirname(destination));
    const actualDestination = path.join(parent, path.basename(destination));
    const relative = path.relative(local, actualDestination);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
        throw new Error("Archive output must be outside local-dir to avoid packaging itself");
    }
    if (fs.existsSync(actualDestination)) { throw new Error("Archive output already exists; refusing to overwrite it"); }

    const state = await getLocalFiles(args);
    if (state.data.some(item => item.name === args["state-name"] && item.type === "folder")) {
        throw new Error("state-name collides with a local folder");
    }
    state.data = state.data.filter(item => item.name !== args["state-name"] &&
        item.name !== `${args["state-name"]}.backup` && !item.name.startsWith(`${args["state-name"]}.upload-`));
    const stateName = args["state-name"];
    const names = new Set(state.data.map(item => item.name));
    if (names.has(stateName) || state.data.some(item => item.type === "file" && stateName.startsWith(item.name + "/")) ||
        state.data.some(item => item.name.startsWith(stateName + "/"))) {
        throw new Error("state-name collides with a local file");
    }

    const zip = new ZipFile();
    const temporary = path.join(parent, `.ftp-deploy-archive-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
    try {
        for (const item of state.data) {
            if (item.name.startsWith("/") || item.name.includes("\\") || item.name.split("/").some(part => !part || part === "." || part === "..")) {
                throw new Error(`Unsafe archive entry: ${item.name}`);
            }
            const source = path.join(local, ...item.name.split("/"));
            // Reject links in any part of the path.
            const resolved = fs.realpathSync(source);
            const inside = path.relative(local, resolved);
            const parts = item.name.split("/");
            const hasSymlink = parts.some((_, index) => fs.lstatSync(path.join(local, ...parts.slice(0, index + 1))).isSymbolicLink());
            if (!inside || inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside) || hasSymlink) {
                throw new Error(`Unsafe archive source: ${item.name}`);
            }
            if (item.type === "folder") { zip.addEmptyDirectory(item.name); }
            else { zip.addFile(source, item.name, { compress: true }); }
        }
        // Do not track the state file as an uploaded file.
        zip.addBuffer(Buffer.from(JSON.stringify(state, undefined, 4)), stateName);
        zip.end();
        await pipeline(zip.outputStream, fs.createWriteStream(temporary, { flags: "wx" }));
        // Stop if any files changed while we built the ZIP.
        for (const item of state.data) {
            if (item.type === "file") {
                const source = path.join(local, ...item.name.split("/"));
                if (fs.statSync(source).size !== item.size || await fileHash(source, "sha256") !== item.hash) {
                    throw new Error(`File changed while creating archive: ${item.name}; retry from a stable snapshot`);
                }
            }
        }
        fs.renameSync(temporary, actualDestination);
        return state;
    }
    finally {
        fs.rmSync(temporary, { force: true });
    }
}

/** Upload the ZIP to an empty FTP directory for manual extraction. */
export async function uploadArchive(output: string, options: IFtpDeployArguments): Promise<string> {
    const args = getDefaultSettings(options);
    const client = new ftp.Client(args.timeout);
    const logger = new Logger(args["log-level"]);
    const operations = new FtpOperations(client, args, logger, new Timings());
    try {
        await operations.connect();
        const entries = await operations.run("inspect bootstrap destination", async () => client.list(operations.rootPath));
        if (entries.length > 0) {
            logger.standard("⚠️ server-dir is not empty. The ZIP will still upload, but extracting it may overwrite matching files and leave other server files in place.");
        }
        // Include the upload time and GitHub run ID (if available) in the filename.
        const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        const runId = /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ? `-run-${process.env.GITHUB_RUN_ID}` : "";
        const remoteName = `ftp-deploy-bootstrap-${timestamp}${runId}-${randomBytes(6).toString("hex")}.zip`;
        const remotePath = `${operations.rootPath.replace(/\/$/, "")}/${remoteName}`;
        await operations.run("upload bootstrap archive", async () => client.uploadFrom(output, remotePath));
        return remoteName;
    }
    finally {
        client.close();
    }
}
