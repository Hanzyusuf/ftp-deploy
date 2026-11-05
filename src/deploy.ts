import * as ftp from "basic-ftp";
import fs from "fs";
import os from "os";
import path from "path";
import { IFileList, IDiff, syncFileDescription, currentSyncFileVersion, IFtpDeployArgumentsWithDefaults } from "./types";
import { HashDiff } from "./HashDiff";
import { ILogger, retryRequest, ITimings, applyExcludeFilter, formatNumber } from "./utilities";
import prettyBytes from "pretty-bytes";
import { prettyError } from "./errorHandling";
import { ensureDir, FTPSyncProvider } from "./syncProvider";
import { getLocalFiles } from "./localFiles";
import { FtpOperations } from "./ftpOperations";

async function downloadFileList(client: ftp.Client, logger: ILogger, remotePath: string, operations?: FtpOperations): Promise<IFileList> {
    // Use a new file so an incomplete download cannot be read as saved state.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ftp-deploy-"));
    const tempFile = path.join(directory, "state.json");
    try {
        const download = async () => client.downloadTo(tempFile, remotePath);
        if (operations) { await operations.run("download server state", download); }
        else { await retryRequest(logger, download); }
        const state = JSON.parse(fs.readFileSync(tempFile, "utf8")) as IFileList;
        if (state.version !== currentSyncFileVersion || !Number.isFinite(state.generatedTime) || !Array.isArray(state.data) ||
            !state.data.every(item => typeof item.name === "string" && item.name.length > 0 &&
                !item.name.startsWith("/") && !item.name.includes("\\") && !item.name.split("/").includes("..") &&
                (item.type === "folder" || (item.type === "file" && typeof item.hash === "string" && Number.isFinite(item.size) && item.size >= 0))) ||
            new Set(state.data.map(item => item.name)).size !== state.data.length) {
            throw new Error("Invalid or unsupported server state file; refusing to deploy without a valid baseline");
        }
        return state;
    }
    finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function createLocalState(localFiles: IFileList, logger: ILogger, args: IFtpDeployArgumentsWithDefaults): void {
    logger.verbose(`Creating local state at ${args["local-dir"]}${args["state-name"]}`);
    fs.writeFileSync(`${args["local-dir"]}${args["state-name"]}`, JSON.stringify(localFiles, undefined, 4), { encoding: "utf8" });
    logger.verbose("Local state created");
}

export async function getServerFiles(client: ftp.Client, logger: ILogger, timings: ITimings, args: IFtpDeployArgumentsWithDefaults, operations?: FtpOperations): Promise<IFileList> {
        if (!operations) { await ensureDir(client, logger, timings, args["server-dir"]); }

        if (args["dangerous-clean-slate"]) {
            logger.all(`----------------------------------------------------------------`);
            logger.all("🗑️ Removing all files on the server because 'dangerous-clean-slate' was set, this will make the deployment very slow...");
            if (args["dry-run"] === false) {
                if (operations) { await operations.run("clear server directory", async () => {
                    await client.cd(operations.rootPath);
                    await client.clearWorkingDir();
                }); }
                else { await client.clearWorkingDir(); }
            }
            logger.all("Clear complete");

            return { description: syncFileDescription, version: currentSyncFileVersion, generatedTime: Date.now(), data: [] };
        }

        // Start fresh only when the state file is actually missing.
        const stateDirectory = path.posix.dirname(args["state-name"]);
        let listPath = operations ? operations.rootPath : ".";
        let entries = operations ? await operations.run("list server state", async () => client.list(listPath)) : await retryRequest(logger, async () => client.list(listPath));
        if (stateDirectory !== ".") {
            for (const part of stateDirectory.split("/")) {
                const folder = entries.find(entry => entry.name === part && entry.isDirectory);
                if (!folder) {
                    logger.all("No state directory on server; treating this as a first publish.");
                    return { description: syncFileDescription, version: currentSyncFileVersion, generatedTime: Date.now(), data: [] };
                }
                listPath = `${listPath.replace(/\/$/, "")}/${part}`;
                entries = operations ? await operations.run("list server state", async () => client.list(listPath)) : await retryRequest(logger, async () => client.list(listPath));
            }
        }
        const hasState = entries.some(entry => entry.name === path.posix.basename(args["state-name"]));
        const hasBackup = entries.some(entry => entry.name === `${path.posix.basename(args["state-name"])}.backup`);
        if (!hasState && !hasBackup) {
            logger.all(`No state file on server; treating this as a first publish.`);
            return { description: syncFileDescription, version: currentSyncFileVersion, generatedTime: Date.now(), data: [] };
        }
        if (!hasState) { logger.all("Previous state publication was interrupted; using preserved backup state."); }
        const serverFiles = await downloadFileList(client, logger, hasState ? args["state-name"] : `${args["state-name"]}.backup`, operations);
        if (hasState && hasBackup && operations && !args["dry-run"]) {
            await operations.removeFile(`${operations.rootPath.replace(/\/$/, "")}/${args["state-name"]}.backup`);
        }
        logger.all(`----------------------------------------------------------------`);
        logger.all(`Last published on 📅 ${new Date(serverFiles.generatedTime).toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "numeric" })}`);

        // apply exclude options to server
        serverFiles.data = serverFiles.data.filter(item => item.name !== args["state-name"] &&
            item.name !== `${args["state-name"]}.backup` && !item.name.startsWith(`${args["state-name"]}.upload-`) &&
            (args.exclude.length === 0 || applyExcludeFilter({ path: item.name, isDirectory: () => item.type === "folder" }, args.exclude)));

        return serverFiles;
}

export async function deploy(args: IFtpDeployArgumentsWithDefaults, logger: ILogger, timings: ITimings): Promise<void> {
    timings.start("total");

    // header
    logger.all(`----------------------------------------------------------------`);
    logger.all(`🚀 Thanks for using ftp-deploy. Let's deploy some stuff!   `);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`If you found this project helpful, please support it`);
    logger.all(`by giving it a ⭐ on Github --> https://github.com/SamKirkland/FTP-Deploy-Action`);
    logger.all(`or add a badge 🏷️ to your projects readme --> https://github.com/SamKirkland/FTP-Deploy-Action#badge`);
    logger.verbose(`Using the following excludes filters: ${JSON.stringify(args.exclude)}`);

    timings.start("hash");
    const localFiles = await getLocalFiles(args);
    localFiles.data = localFiles.data.filter(item => item.name !== args["state-name"] &&
        item.name !== `${args["state-name"]}.backup` && !item.name.startsWith(`${args["state-name"]}.upload-`));
    timings.stop("hash");

    createLocalState(localFiles, logger, args);

    const client = new ftp.Client(args.timeout);
    const operations = new FtpOperations(client, args, logger, timings);


    let totalBytesUploaded = 0;
    try {
        await operations.connect();

        const serverFiles = await getServerFiles(client, logger, timings, args, operations);

        timings.start("logging");
        const diffTool: IDiff = new HashDiff();

        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Local Files:\t${formatNumber(localFiles.data.length)}`);
        logger.standard(`Server Files:\t${formatNumber(serverFiles.data.length)}`);
        logger.standard(`----------------------------------------------------------------`);
        logger.standard(`Calculating differences between client & server`);
        logger.standard(`----------------------------------------------------------------`);

        const diffs = diffTool.getDiffs(localFiles, serverFiles);

        diffs.upload.filter((itemUpload) => itemUpload.type === "folder").map((itemUpload) => {
            logger.standard(`📁 Create: ${itemUpload.name}`);
        });

        diffs.upload.filter((itemUpload) => itemUpload.type === "file").map((itemUpload) => {
            logger.standard(`📄 Upload: ${itemUpload.name}`);
        });

        diffs.replace.map((itemReplace) => {
            logger.standard(`🔁 File replace: ${itemReplace.name}`);
        });

        diffs.delete.filter((itemUpload) => itemUpload.type === "file").map((itemDelete) => {
            logger.standard(`📄 Delete: ${itemDelete.name}    `);
        });

        diffs.delete.filter((itemUpload) => itemUpload.type === "folder").map((itemDelete) => {
            logger.standard(`📁 Delete: ${itemDelete.name}    `);
        });

        diffs.same.map((itemSame) => {
            if (itemSame.type === "file") {
                logger.standard(`⚖️  File content is the same, doing nothing: ${itemSame.name}`);
            }
        });
        timings.stop("logging");


        totalBytesUploaded = diffs.sizeUpload + diffs.sizeReplace;

        timings.start("upload");
        try {
            const syncProvider = new FTPSyncProvider(client, logger, timings, args["local-dir"], args["server-dir"], args["state-name"], args["dry-run"], operations);
            await syncProvider.syncLocalToServer(diffs);
        }
        finally {
            timings.stop("upload");
        }
    }
    catch (error) {
        prettyError(logger, args, error);
        throw error;
    }
    finally {
        client.close();
        timings.stop("total");
    }


    const uploadSpeed = prettyBytes(totalBytesUploaded / (timings.getTime("upload") / 1000));

    // footer
    logger.all(`----------------------------------------------------------------`);
    logger.all(`Time spent hashing: ${timings.getTimeFormatted("hash")}`);
    logger.all(`Time spent connecting to server: ${timings.getTimeFormatted("connecting")}`);
    logger.all(`Time spent deploying: ${timings.getTimeFormatted("upload")} (${uploadSpeed}/second)`);
    logger.all(`  - changing dirs: ${timings.getTimeFormatted("changingDir")}`);
    logger.all(`  - logging: ${timings.getTimeFormatted("logging")}`);
    logger.all(`----------------------------------------------------------------`);
    logger.all(`Total time: ${timings.getTimeFormatted("total")}`);
    logger.all(`----------------------------------------------------------------`);
}
